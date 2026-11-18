// Builds public/kg-index.json: every Austrian cadastral community (KG) with
// its number, name, state and bounding box, taken from the BEV cadastre tiles.
//
// The app uses it to find a KG by name or number without loading the map
// first. Runs in GitHub Actions (.github/workflows/kg-index.yml), because the
// BEV servers have to be reachable.
//
//   node scripts/build-kg-index.mjs            # zoom 10 by default
//   KG_ZOOM=11 node scripts/build-kg-index.mjs

import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { writeFile } from 'node:fs/promises';

const Z = Number(process.env.KG_ZOOM ?? 10);
const TILE_URL = process.env.TILE_URL ?? 'https://kataster.bev.gv.at/tiles/kataster/{z}/{x}/{y}.pbf';
const AUSTRIA = [9.4, 46.3, 17.2, 49.1]; // W S E N
const OUT = new URL(process.env.OUT ?? '../public/kg-index.json', import.meta.url);
const MIN_KGS = Number(process.env.MIN_KGS ?? 7000);
const CONCURRENCY = 8;

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

async function fetchTile(z, x, y, tries = 3) {
  const url = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'forester-kg-index (github.com/Reckless5/forester)' } });
      if (res.status === 204 || res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return buf.length ? new VectorTile(new Pbf(buf)) : null;
    } catch (e) {
      if (i === tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

const kgs = new Map(); // kg_nr -> { name, bl, bbox }
const stats = { tiles: 0, empty: 0, withKg: 0 };

function addFeature(f, x, y) {
  const p = f.properties;
  const nr = String(p.kg_nr ?? '').trim();
  if (!/^\d{5}$/.test(nr)) return;
  const geom = f.toGeoJSON(x, y, Z).geometry;
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.type === 'MultiPolygon' ? geom.coordinates.flat() : [];
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of rings)
    for (const [lx, ly] of ring) {
      if (lx < minX) minX = lx;
      if (ly < minY) minY = ly;
      if (lx > maxX) maxX = lx;
      if (ly > maxY) maxY = ly;
    }
  if (!Number.isFinite(minX)) return;
  const cur = kgs.get(nr);
  if (cur) {
    cur.bbox = [Math.min(cur.bbox[0], minX), Math.min(cur.bbox[1], minY), Math.max(cur.bbox[2], maxX), Math.max(cur.bbox[3], maxY)];
  } else kgs.set(nr, { name: String(p.kg ?? ''), bl: String(p.bl ?? ''), bbox: [minX, minY, maxX, maxY] });
}

const jobs = [];
for (let x = lon2x(AUSTRIA[0], Z); x <= lon2x(AUSTRIA[2], Z); x++)
  for (let y = lat2y(AUSTRIA[3], Z); y <= lat2y(AUSTRIA[1], Z); y++) jobs.push([x, y]);

console.log(`Zoom ${Z}: fetching ${jobs.length} tiles…`);
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const [x, y] = jobs[next++];
      const tile = await fetchTile(Z, x, y);
      stats.tiles++;
      if (!tile) { stats.empty++; continue; }
      const layer = tile.layers.kg;
      if (!layer) continue;
      stats.withKg++;
      for (let i = 0; i < layer.length; i++) addFeature(layer.feature(i), x, y);
    }
  }),
);

console.log(stats, `${kgs.size} KGs`);
if (kgs.size < MIN_KGS) {
  console.error(`Only ${kgs.size} KGs found – expected about 7,850. Try another KG_ZOOM.`);
  process.exit(1);
}

const bls = [...new Set([...kgs.values()].map((k) => k.bl))].sort();
const r = (n) => Math.round(n * 1e5) / 1e5;
const rows = [...kgs.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([nr, k]) => [nr, k.name, bls.indexOf(k.bl), ...k.bbox.map(r)]);

await writeFile(
  OUT,
  JSON.stringify({
    source: 'BEV Kataster (CC BY 4.0), kataster.bev.gv.at',
    generated: new Date().toISOString().slice(0, 10),
    zoom: Z,
    fields: ['kgNr', 'name', 'blIndex', 'west', 'south', 'east', 'north'],
    bl: bls,
    kgs: rows,
  }),
);
console.log(`Wrote ${OUT.pathname} (${rows.length} KGs)`);
