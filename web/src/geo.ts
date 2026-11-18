// Small geometry helpers, so we don't need a GIS library for the basics.

export type Ring = [number, number][];
export type PolygonCoords = Ring[];
export type MultiPolygon = { type: 'MultiPolygon'; coordinates: PolygonCoords[] };
export type LngLat = [number, number];

type AnyGeom = { type: string; coordinates: unknown };

/** Normalises Polygon / MultiPolygon to a list of polygons. Other types → []. */
export function toPolygons(geom: AnyGeom | null | undefined): PolygonCoords[] {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates as PolygonCoords];
  if (geom.type === 'MultiPolygon') return geom.coordinates as PolygonCoords[];
  return [];
}

function pointInRing([x, y]: LngLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygons(p: LngLat, polys: PolygonCoords[]): boolean {
  return polys.some(
    ([outer, ...holes]) => pointInRing(p, outer) && !holes.some((h) => pointInRing(p, h)),
  );
}

export function bbox(polys: PolygonCoords[]): [LngLat, LngLat] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polys)
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return [[minX, minY], [maxX, maxY]];
}

/** Planar ring area in degrees² (only used to compare pieces, not for real areas). */
function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return Math.abs(a / 2);
}

/** Area-weighted centroid of outer rings; falls back to bbox centre. */
export function centroid(polys: PolygonCoords[]): LngLat {
  let ax = 0, ay = 0, at = 0;
  for (const poly of polys) {
    const ring = poly[0];
    const a = ringArea(ring);
    let cx = 0, cy = 0;
    for (const [x, y] of ring) { cx += x; cy += y; }
    cx /= ring.length; cy /= ring.length;
    ax += cx * a; ay += cy * a; at += a;
  }
  if (at === 0) {
    const [[x0, y0], [x1, y1]] = bbox(polys);
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  const c: LngLat = [ax / at, ay / at];
  // A concave parcel's centroid can lie outside it (e.g. L-shapes).
  if (!pointInPolygons(c, polys)) {
    const largest = polys.reduce((m, p) => (ringArea(p[0]) > ringArea(m[0]) ? p : m));
    return interiorPoint(largest);
  }
  return c;
}

/** A point guaranteed inside the polygon: middle of the widest horizontal span. */
function interiorPoint(poly: PolygonCoords): LngLat {
  const [[, y0], [, y1]] = bbox([poly]);
  let best: LngLat = poly[0][0];
  let bestWidth = -1;
  for (const t of [0.5, 0.25, 0.75, 0.1, 0.9]) {
    const y = y0 + (y1 - y0) * t;
    const xs: number[] = [];
    for (const ring of poly)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1] - xs[k];
      if (w > bestWidth) {
        bestWidth = w;
        best = [(xs[k] + xs[k + 1]) / 2, y];
      }
    }
  }
  return best;
}

/** Real area in m² using a local equirectangular projection (fine for parcel sizes). */
export function areaM2(polys: PolygonCoords[]): number {
  const R = 6371008.8;
  const lat0 = (centroid(polys)[1] * Math.PI) / 180;
  const k = Math.cos(lat0);
  let total = 0;
  for (const [outer, ...holes] of polys) {
    const proj = (r: Ring): Ring => r.map(([x, y]) => [((x * Math.PI) / 180) * R * k, ((y * Math.PI) / 180) * R]);
    total += ringArea(proj(outer)) - holes.reduce((s, h) => s + ringArea(proj(h)), 0);
  }
  return total;
}

export function distanceM(a: LngLat, b: LngLat): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x =
    Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
    Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
export function compass(deg: number): string {
  return COMPASS[Math.round(deg / 45) % 8];
}

export function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

export function formatArea(m2: number): string {
  return m2 >= 9999.5 ?`${(m2 / 10000).toFixed(2)} ha` : `${Math.round(m2)} m²`;
}
