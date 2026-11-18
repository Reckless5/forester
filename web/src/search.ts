// Search: own parcels, parcels by KG + number, cadastral communities (KG) and
// places (villages, towns, peaks, …).
//
// - KGs come from public/kg-index.json (built from the BEV tiles by
//   scripts/build-kg-index.mjs).
// - A parcel is found by downloading the BEV parcel tiles covering its KG
//   and looking up the parcel number, so it works anywhere in Austria.
// - Places come from Photon (OpenStreetMap), see https://photon.komoot.io.

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import polygonClipping from 'polygon-clipping';
import { AUSTRIA_BOUNDS, KATASTER_TILES } from './config';
import { areaM2, bbox, centroid, toPolygons, type LngLat, type PolygonCoords } from './geo';
import type { ParcelInfo } from './parcel';

export type BBox = [number, number, number, number]; // W S E N

// ---------- Text helpers ----------
export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9./ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---------- KG index ----------
export interface Kg {
  nr: string;
  name: string;
  bl: string;
  bbox: BBox;
  norm: string;
}

let kgIndex: Promise<Kg[]> | undefined;

export function loadKgIndex(): Promise<Kg[]> {
  kgIndex ??= fetch(`${import.meta.env.BASE_URL}kg-index.json`)
    .then((r) => {
      if (!r.ok) throw new Error(`KG-Verzeichnis nicht gefunden (${r.status})`);
      return r.json();
    })
    .then((d: { bl: string[]; kgs: [string, string, number, number, number, number, number][] }) =>
      d.kgs.map(([nr, name, bl, w, s, e, n]) => ({ nr, name, bl: d.bl[bl], bbox: [w, s, e, n] as BBox, norm: normalize(name) })),
    )
    .catch((e) => {
      kgIndex = undefined; // allow a retry
      throw e;
    });
  return kgIndex;
}

/** KGs matching a name or number, best matches first. */
export function matchKgs(kgs: Kg[], query: string, limit = 6): Kg[] {
  const q = normalize(query);
  if (!q) return [];
  if (/^\d+$/.test(q)) return kgs.filter((k) => k.nr.startsWith(q)).slice(0, limit);
  const scored: [number, Kg][] = [];
  for (const k of kgs) {
    let score = -1;
    if (k.norm === q) score = 0;
    else if (k.norm.startsWith(q)) score = 1;
    else if (k.norm.split(' ').some((w) => w.startsWith(q))) score = 2;
    else if (k.norm.includes(q)) score = 3;
    if (score >= 0) scored.push([score, k]);
  }
  return scored
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'de'))
    .slice(0, limit)
    .map(([, k]) => k);
}

export const kgsAt = (kgs: Kg[], [x, y]: LngLat) =>
  kgs.filter(({ bbox: [w, s, e, n] }) => x >= w && x <= e && y >= s && y <= n);

// ---------- Parsing "KG + parcel number" ----------
// Accepts e.g. "63269 1009/1", "63269-1009/1", "Rabnitz 1009/1", "Rabnitz Gst 1009/1",
// "1009/1" (in the KG at the map centre), ".12" (building plots).
const GNR = String.raw`\.?\d+(?:\/\d+)?`;

export interface ParcelQuery {
  kg?: string; // name or number; undefined = KG at the map centre
  gnr: string;
}

export function parseParcelQuery(input: string): ParcelQuery | undefined {
  const s = input.trim().replace(/\s+/g, ' ');
  let m = s.match(new RegExp(`^(\\d{5})\\s*[-,/ ]\\s*(?:gst\\.?|gnr\\.?)?\\s*(${GNR})$`, 'i'));
  if (m) return { kg: m[1], gnr: m[2] };
  m = s.match(new RegExp(`^(?:gst\\.?|gnr\\.?)?\\s*(${GNR})$`, 'i'));
  if (m) return { gnr: m[1] };
  m = s.match(new RegExp(`^(.*?[^\\d\\s].*?)[ ,]+(?:gst\\.?|gnr\\.?)?\\s*(${GNR})$`, 'i'));
  if (m) return { kg: m[1].trim(), gnr: m[2] };
  return undefined;
}

// ---------- Finding a parcel in the BEV tiles ----------
const Z = 14; // parcels are in the tiles from zoom 14
const MAX_TILES = 120;
const lon2x = (lon: number) => Math.floor(((lon + 180) / 360) * 2 ** Z);
const lat2y = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z);
};

async function fetchTile(x: number, y: number, signal?: AbortSignal) {
  const url = KATASTER_TILES.replace('{z}', String(Z)).replace('{x}', String(x)).replace('{y}', String(y));
  const res = await fetch(url, { signal });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length ? new VectorTile(new Pbf(buf)) : null;
}

export async function findParcel(
  kg: Kg,
  gnr: string,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<ParcelInfo | undefined> {
  const [w, s, e, n] = kg.bbox;
  const tiles: [number, number][] = [];
  for (let x = lon2x(w); x <= lon2x(e); x++) for (let y = lat2y(n); y <= lat2y(s); y++) tiles.push([x, y]);
  if (tiles.length > MAX_TILES) throw new Error(`KG ${kg.name} ist zu groß für die Suche (${tiles.length} Kacheln).`);

  // Closest to the KG centre first
  const cx = (lon2x(w) + lon2x(e)) / 2;
  const cy = (lat2y(n) + lat2y(s)) / 2;
  tiles.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));

  const pieces: PolygonCoords[] = [];
  let props: Record<string, unknown> | undefined;
  let id: number | undefined;
  let done = 0;
  let next = 0;
  const want = gnr.trim();

  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < tiles.length) {
        const [x, y] = tiles[next++];
        const tile = await fetchTile(x, y, opts.signal);
        opts.onProgress?.(++done, tiles.length);
        const layer = tile?.layers.gst;
        if (!layer) continue;
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          if (String(f.properties.gnr) !== want || String(f.properties.kg) !== kg.nr) continue;
          const geom = f.toGeoJSON(x, y, Z).geometry;
          pieces.push(...toPolygons(geom as never));
          props ??= f.properties as Record<string, unknown>;
          id ??= f.id;
        }
      }
    }),
  );

  if (!pieces.length) return undefined;
  let polys = pieces;
  if (pieces.length > 1) {
    try {
      const [first, ...rest] = pieces;
      polys = polygonClipping.union(first, ...rest) as PolygonCoords[];
    } catch {
      /* keep the pieces */
    }
  }
  return {
    key: `${kg.nr}-${want}`,
    kgNr: kg.nr,
    kgName: kg.name,
    gnr: want,
    rstatus: props?.rstatus ? String(props.rstatus) : undefined,
    geometry: { type: 'MultiPolygon', coordinates: polys },
    center: centroid(polys),
    areaM2: areaM2(polys),
    complete: true,
    raw: { gst: props ?? {}, gstId: id },
  };
}

export const polysBBox = (polys: PolygonCoords[]): BBox => {
  const [[w, s], [e, n]] = bbox(polys);
  return [w, s, e, n];
};

// ---------- Places (Photon / OpenStreetMap) ----------
export interface Place {
  name: string;
  kind: string;
  context: string;
  center: LngLat;
  bbox?: BBox;
  zoom: number;
}

const KIND: Record<string, [string, number]> = {
  city: ['Stadt', 12],
  town: ['Stadt', 13],
  village: ['Dorf', 14],
  hamlet: ['Weiler', 15],
  isolated_dwelling: ['Einzelhof', 16],
  farm: ['Hof', 16],
  locality: ['Flur', 15],
  suburb: ['Ortsteil', 14],
  neighbourhood: ['Ortsteil', 15],
  municipality: ['Gemeinde', 12],
  peak: ['Gipfel', 15],
  saddle: ['Sattel', 15],
  ridge: ['Bergrücken', 14],
  valley: ['Tal', 13],
  water: ['Gewässer', 14],
  lake: ['See', 14],
  stream: ['Bach', 14],
  river: ['Fluss', 13],
  wood: ['Wald', 14],
  forest: ['Wald', 14],
  alpine_hut: ['Hütte', 16],
  wilderness_hut: ['Hütte', 16],
  chapel: ['Kapelle', 17],
  church: ['Kirche', 17],
  wayside_shrine: ['Marterl', 17],
  wayside_cross: ['Wegkreuz', 17],
  viewpoint: ['Aussichtspunkt', 16],
  castle: ['Burg', 16],
  ruins: ['Ruine', 16],
  parking: ['Parkplatz', 17],
};

interface PhotonFeature {
  geometry: { coordinates: LngLat };
  properties: {
    name?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
    street?: string;
    housenumber?: string;
    city?: string;
    district?: string;
    county?: string;
    state?: string;
    country?: string;
    countrycode?: string;
    extent?: [number, number, number, number]; // minLon, maxLat, maxLon, minLat
  };
}

export async function searchPlaces(query: string, near: LngLat, signal?: AbortSignal): Promise<Place[]> {
  const [[w, s], [e, n]] = AUSTRIA_BOUNDS;
  const params = new URLSearchParams({
    q: query,
    lang: 'de',
    limit: '8',
    bbox: [w, s, e, n].join(','),
    lon: near[0].toFixed(4),
    lat: near[1].toFixed(4),
    location_bias_scale: '0.3',
  });
  const res = await fetch(`https://photon.komoot.io/api/?${params}`, { signal });
  if (!res.ok) throw new Error(`Ortssuche nicht erreichbar (${res.status})`);
  const data: { features: PhotonFeature[] } = await res.json();
  return data.features
    .filter((f) => f.properties.countrycode === 'AT' && (f.properties.name || f.properties.street))
    .map((f) => {
      const p = f.properties;
      const [label, zoom] = KIND[p.osm_value ?? ''] ?? [p.type === 'house' ? 'Adresse' : 'Ort', 16];
      const name = p.name ?? [p.street, p.housenumber].filter(Boolean).join(' ');
      const context = [p.city !== name ? p.city : undefined, p.district, p.county, p.state]
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .slice(0, 2)
        .join(', ');
      return {
        name,
        kind: label,
        context,
        center: f.geometry.coordinates,
        bbox: p.extent ? ([p.extent[0], p.extent[3], p.extent[2], p.extent[1]] as BBox) : undefined,
        zoom,
      };
    });
}
