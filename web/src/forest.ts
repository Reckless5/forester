// Works out which parcels contain forest.
//
// Parcels (`gst`) carry no land use. Land use is in separate polygons (`nfl`,
// field `ns`), and each of those lies inside exactly one parcel. So for every
// forest polygon we take a point inside it, find the parcel containing that
// point and mark the parcel with feature-state `forest: true`. The parcel
// layers then only draw marked parcels.
//
// Parcel and label ids are stable across tiles, so the marks carry over when
// new tiles load or when the user zooms.

import type { Map as MLMap, GeoJSONFeature } from 'maplibre-gl';
import { NS_DWARF_PINE, NS_FOREST, PARCEL_MINZOOM } from './config';
import { bbox, interiorPoint, pointInPolygons, toPolygons, type LngLat, type PolygonCoords } from './geo';

type Id = string | number;
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

export function createForestIndex(map: MLMap) {
  const forestParcels = new Set<Id>();
  const doneForestAreas = new Set<string>();
  const doneLabels = new Set<Id>();

  const mark = (sourceLayer: 'gst' | 'gnr', id: Id) =>
    map.setFeatureState({ source: 'kataster', sourceLayer, id }, { forest: true });

  function update() {
    if (map.getZoom() < PARCEL_MINZOOM - 0.5 || !map.getSource('kataster')) return;

    const areas = map.querySourceFeatures('kataster', {
      sourceLayer: 'nfl',
      filter: ['in', ['get', 'ns'], ['literal', [NS_FOREST, NS_DWARF_PINE]]],
    });
    const points: LngLat[] = [];
    for (const a of areas) {
      for (const poly of toPolygons(a.geometry as never)) {
        // Tile pieces of one area share an id, so key on id + piece position
        const sig = `${a.id}:${poly[0][0][0].toFixed(6)},${poly[0][0][1].toFixed(6)}`;
        if (doneForestAreas.has(sig)) continue;
        doneForestAreas.add(sig);
        points.push(interiorPoint(poly));
      }
    }

    const parcels = map.querySourceFeatures('kataster', { sourceLayer: 'gst' });
    const parcelAt = buildGrid(parcels);

    for (const p of points) {
      const id = parcelAt(p);
      if (id !== undefined && !forestParcels.has(id)) {
        forestParcels.add(id);
        mark('gst', id);
      }
    }

    // Parcel-number labels: show those that sit in a forest parcel
    for (const label of map.querySourceFeatures('kataster', { sourceLayer: 'gnr' })) {
      if (label.id === undefined || label.id === null || doneLabels.has(label.id)) continue;
      if (label.geometry.type !== 'Point') continue;
      const id = parcelAt(label.geometry.coordinates as LngLat);
      // Not (yet) forest: check again next time, the forest area may be in a tile still loading
      if (id === undefined || !forestParcels.has(id)) continue;
      doneLabels.add(label.id);
      mark('gnr', label.id);
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
      if (ms > 50) console.debug(`[forest] update took ${ms.toFixed(0)} ms`);
    }, 0);
  });

  return {
    isForest: (id: Id | undefined) => id !== undefined && forestParcels.has(id),
    count: () => forestParcels.size,
  };
}
