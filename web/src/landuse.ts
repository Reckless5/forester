// Works out which parcels contain forest and which contain fields.
//
// Parcels (`gst`) carry no land use. Land use is in separate polygons (`nfl`,
// field `ns`), and each of those lies inside exactly one parcel. So for every
// forest or field polygon we take a point inside it, find the parcel
// containing that point and mark the parcel with feature-state `forest: true`
// or `field: true`. The parcel layers then only draw the kinds that are
// switched on in the map menu.
//
// Parcel and label ids are stable across tiles, so the marks carry over when
// new tiles load or when the user zooms.

import type { Map as MLMap, GeoJSONFeature } from 'maplibre-gl';
import { NS_DWARF_PINE, NS_FIELD, NS_FOREST, PARCEL_MINZOOM } from './config';
import { bbox, interiorPoint, pointInPolygons, toPolygons, type LngLat, type PolygonCoords } from './geo';

type Id = string | number;
export type LandUse = 'forest' | 'field';

/** Land-use codes (BEV "NS") that make a parcel count as forest or field. */
const CLASSES: Record<LandUse, number[]> = {
  forest: [NS_FOREST, NS_DWARF_PINE], // Wälder, Krummholzflächen
  field: [NS_FIELD], // Äcker, Wiesen oder Weiden
};
const ALL_CODES = Object.values(CLASSES).flat();
const classOf = (ns: number): LandUse | undefined =>
  (Object.keys(CLASSES) as LandUse[]).find((k) => CLASSES[k].includes(ns));

interface Indexed { id: Id; polys: PolygonCoords[]; box: [LngLat, LngLat] }

const CELL = 0.004; // grid cell size in degrees (~300–450 m)
const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

function buildGrid(features: GeoJSONFeature[]) {
  const grid = new Map<string, Indexed[]>();
  for (const f of features) {
    if (f.id === undefined || f.id === null) continue;
    const polys = toPolygons(f.geometry as never);
    if (!polys.length) continue;
    const box = bbox(polys);
    const item: Indexed = { id: f.id, polys, box };
    for (let cx = Math.floor(box[0][0] / CELL); cx <= Math.floor(box[1][0] / CELL); cx++)
      for (let cy = Math.floor(box[0][1] / CELL); cy <= Math.floor(box[1][1] / CELL); cy++) {
        const k = `${cx}:${cy}`;
        const list = grid.get(k);
        if (list) list.push(item);
        else grid.set(k, [item]);
      }
  }
  return (p: LngLat): Id | undefined => {
    for (const it of grid.get(cellKey(p[0], p[1])) ?? []) {
      const [[x0, y0], [x1, y1]] = it.box;
      if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
      if (pointInPolygons(p, it.polys)) return it.id;
    }
    return undefined;
  };
}

export function createLandUseIndex(map: MLMap) {
  const parcels: Record<LandUse, Set<Id>> = { forest: new Set(), field: new Set() };
  const labels: Record<LandUse, Set<Id>> = { forest: new Set(), field: new Set() };
  const doneAreas = new Set<string>();

  const mark = (sourceLayer: 'gst' | 'gnr', id: Id, use: LandUse) =>
    map.setFeatureState({ source: 'kataster', sourceLayer, id }, { [use]: true });

  function update() {
    if (map.getZoom() < PARCEL_MINZOOM - 0.5 || !map.getSource('kataster')) return;

    const areas = map.querySourceFeatures('kataster', {
      sourceLayer: 'nfl',
      filter: ['in', ['get', 'ns'], ['literal', ALL_CODES]],
    });
    const points: [LngLat, LandUse][] = [];
    for (const a of areas) {
      const use = classOf(Number(a.properties?.ns));
      if (!use) continue;
      for (const poly of toPolygons(a.geometry as never)) {
        // Tile pieces of one area share an id, so key on id + piece position
        const sig = `${a.id}:${poly[0][0][0].toFixed(6)},${poly[0][0][1].toFixed(6)}`;
        if (doneAreas.has(sig)) continue;
        doneAreas.add(sig);
        points.push([interiorPoint(poly), use]);
      }
    }

    const parcelAt = buildGrid(map.querySourceFeatures('kataster', { sourceLayer: 'gst' }));

    for (const [p, use] of points) {
      const id = parcelAt(p);
      if (id !== undefined && !parcels[use].has(id)) {
        parcels[use].add(id);
        mark('gst', id, use);
      }
    }

    // Parcel-number labels: mark those that sit in a forest / field parcel
    for (const label of map.querySourceFeatures('kataster', { sourceLayer: 'gnr' })) {
      if (label.id === undefined || label.id === null || label.geometry.type !== 'Point') continue;
      const lid = label.id;
      const uses = (Object.keys(parcels) as LandUse[]).filter((u) => !labels[u].has(lid));
      if (!uses.length) continue;
      const id = parcelAt(label.geometry.coordinates as LngLat);
      // Not (yet) marked: check again next time, the area may be in a tile still loading
      if (id === undefined) continue;
      for (const u of uses)
        if (parcels[u].has(id)) {
          labels[u].add(lid);
          mark('gnr', lid, u);
        }
    }
  }

  let scheduled = false;
  map.on('idle', () => {
    if (scheduled) return;
    scheduled = true;
    // Let the browser breathe before doing the work
    setTimeout(() => {
      scheduled = false;
      const t = performance.now();
      update();
      const ms = performance.now() - t;
      if (ms > 50) console.debug(`[landuse] update took ${ms.toFixed(0)} ms`);
    }, 0);
  });

  const usesOfIds = (ids: Id[]) => (Object.keys(parcels) as LandUse[]).filter((u) => ids.some((id) => parcels[u].has(id)));

  return {
    is: (use: LandUse, id: Id | undefined) => id !== undefined && parcels[use].has(id),
    /**
     * Land use of a parcel by KG and parcel number, from the tiles currently
     * loaded. Undefined when the parcel isn't loaded (or not classified yet).
     */
    usesOf(kgNr: string | undefined, gnr: string | undefined, gstId?: Id): LandUse[] | undefined {
      const ids: Id[] = gstId !== undefined && gstId !== null ? [gstId] : [];
      if (kgNr && gnr && map.getSource('kataster'))
        for (const f of map.querySourceFeatures('kataster', {
          sourceLayer: 'gst',
          filter: ['all', ['==', ['to-string', ['get', 'gnr']], gnr], ['==', ['to-string', ['get', 'kg']], kgNr]],
        }))
          if (f.id !== undefined && f.id !== null) ids.push(f.id);
      if (!ids.length) return undefined;
      const uses = usesOfIds(ids);
      return uses.length ? uses : undefined;
    },
  };
}
