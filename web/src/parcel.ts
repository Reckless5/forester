// Works out which parcel was tapped, using only what's in the BEV vector tiles.
//
// The tiles don't document their attribute names (only `rstatus` on `gst`,
// `gnr` on the label layer and `kg` on the KG layer are known from the BEV
// style). So we try a few likely field names and fall back to looking up the
// parcel-number label that sits inside the tapped polygon. The raw attributes
// are kept so we can check them in the app ("Technische Details").

import type { Map as MLMap, MapGeoJSONFeature, LngLat as MLLngLat } from 'maplibre-gl';
import polygonClipping from 'polygon-clipping';
import {
  areaM2,
  bbox,
  centroid,
  pointInPolygons,
  toPolygons,
  type LngLat,
  type MultiPolygon,
  type PolygonCoords,
} from './geo';
import { L } from './style';

export interface ParcelInfo {
  key: string;
  kgNr?: string;
  kgName?: string;
  gnr?: string;
  /** 'G' = Grenzkataster (legally binding), 'E' = Grundsteuerkataster */
  rstatus?: string;
  geometry: MultiPolygon;
  center: LngLat;
  areaM2: number;
  /** False when part of the parcel lies outside the loaded map area. */
  complete: boolean;
  raw: { gst: Record<string, unknown>; gstId?: string | number; kg?: Record<string, unknown> };
}

type Props = Record<string, unknown>;

const KG_NR_FIELDS = ['kgnr', 'kg_nr', 'KGNR', 'KG', 'kgnummer', 'kg'];
const GNR_FIELDS = ['gnr', 'GNR', 'gstnr', 'GSTNR', 'gst', 'GST'];
const isKgNr = (v: string) => /^\d{5}$/.test(v);

function pick(props: Props | undefined, fields: string[], test?: (v: string) => boolean) {
  if (!props) return undefined;
  for (const f of fields) {
    const v = props[f];
    if (v === undefined || v === null || v === '') continue;
    const s = String(v).trim();
    if (!test || test(s)) return s;
  }
  return undefined;
}

function bboxesTouch(a: [LngLat, LngLat], b: [LngLat, LngLat], eps = 1e-7) {
  return a[0][0] <= b[1][0] + eps && b[0][0] <= a[1][0] + eps && a[0][1] <= b[1][1] + eps && b[0][1] <= a[1][1] + eps;
}

/**
 * Vector tiles cut big parcels into pieces at tile edges. Collect the pieces
 * that belong to the tapped one: same feature id or same parcel number, and
 * connected to the tapped piece.
 */
function gatherPieces(map: MLMap, tapped: MapGeoJSONFeature, kgNr?: string, gnr?: string): PolygonCoords[] {
  const base = toPolygons(tapped.geometry as never);
  let candidates: MapGeoJSONFeature[] = [];

  const gnrField = GNR_FIELDS.find((f) => tapped.properties?.[f] != null);
  if (gnr && gnrField) {
    candidates = map.querySourceFeatures('kataster', {
      sourceLayer: 'gst',
      filter: ['==', ['to-string', ['get', gnrField]], gnr],
    }) as MapGeoJSONFeature[];
    const kgField = KG_NR_FIELDS.find((f) => isKgNr(String(tapped.properties?.[f] ?? '')));
    if (kgNr && kgField) candidates = candidates.filter((c) => String(c.properties?.[kgField]) === kgNr);
  } else if (tapped.id !== undefined && tapped.id !== null) {
    candidates = map.querySourceFeatures('kataster', {
      sourceLayer: 'gst',
      filter: ['==', ['id'], tapped.id as number],
    }) as MapGeoJSONFeature[];
  }

  // Grow outwards from the tapped piece so unrelated matches elsewhere are ignored.
  const pieces: PolygonCoords[] = [...base];
  const seen = new Set(pieces.map((p) => JSON.stringify(p[0].slice(0, 3))));
  let pool = candidates.flatMap((c) => toPolygons(c.geometry as never));
  let grew = true;
  while (grew) {
    grew = false;
    const box = bbox(pieces);
    pool = pool.filter((poly) => {
      const sig = JSON.stringify(poly[0].slice(0, 3));
      if (seen.has(sig)) return false;
      if (bboxesTouch(box, bbox([poly]))) {
        seen.add(sig);
        pieces.push(poly);
        grew = true;
        return false;
      }
      return true;
    });
  }
  // Tile pieces overlap a little (tile buffer). Merge them into one clean shape.
  if (pieces.length < 2) return pieces;
  try {
    const [first, ...rest] = pieces;
    return polygonClipping.union(first, ...rest) as PolygonCoords[];
  } catch (e) {
    console.warn('Could not merge parcel pieces', e);
    return pieces;
  }
}

export function identifyParcel(map: MLMap, tapped: MapGeoJSONFeature, at: MLLngLat): ParcelInfo {
  const props = (tapped.properties ?? {}) as Props;
  let kgNr = pick(props, KG_NR_FIELDS, isKgNr);
  let gnr = pick(props, GNR_FIELDS);
  const rstatus = pick(props, ['rstatus', 'RSTATUS']);

  const kgFeature = map.queryRenderedFeatures(map.project(at), { layers: [L.kgHit] })[0];
  const kgProps = kgFeature?.properties as Props | undefined;
  const kgName = pick(kgProps, ['kg', 'kgname', 'name'], (v) => !isKgNr(v));
  kgNr ??= pick(kgProps, KG_NR_FIELDS, isKgNr);

  const polys = gatherPieces(map, tapped, kgNr, gnr);

  if (!gnr) {
    // Find the parcel-number label inside the polygon
    const labels = map.querySourceFeatures('kataster', { sourceLayer: 'gnr' });
    const label = labels.find(
      (l) => l.geometry.type === 'Point' && pointInPolygons(l.geometry.coordinates as LngLat, polys),
    );
    gnr = pick(label?.properties as Props, GNR_FIELDS);
    kgNr ??= pick(label?.properties as Props, KG_NR_FIELDS, isKgNr);
  }

  const center = centroid(polys);
  // Complete if the parcel doesn't touch the edge of the area whose tiles are loaded
  // (approximated by the extent of all loaded parcels; tiles extend past the screen).
  const box = bbox(polys);
  const loaded = bbox(
    map.querySourceFeatures('kataster', { sourceLayer: 'gst' }).flatMap((f) => toPolygons(f.geometry as never)),
  );
  const eps = 1e-6;
  const complete =
    box[0][0] > loaded[0][0] + eps &&
    box[1][0] < loaded[1][0] - eps &&
    box[0][1] > loaded[0][1] + eps &&
    box[1][1] < loaded[1][1] - eps;

  const key =
    kgNr && gnr
      ? `${kgNr}-${gnr}`
      : `${kgName ?? 'kg'}-${gnr ?? `${center[0].toFixed(5)},${center[1].toFixed(5)}`}`;

  return {
    key,
    kgNr,
    kgName,
    gnr,
    rstatus,
    geometry: { type: 'MultiPolygon', coordinates: polys },
    center,
    areaM2: areaM2(polys),
    complete,
    raw: { gst: props, gstId: tapped.id ?? undefined, kg: kgProps },
  };
}
