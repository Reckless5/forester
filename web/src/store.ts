// "Meine Grundstücke": saved on this device for now (localStorage).
// Later this moves to a backend so owners can use several devices.

import type { LngLat, MultiPolygon } from './geo';

export interface SavedParcel {
  /** Stable id: "<KG-Nr>-<Gst-Nr>" when known, otherwise a fallback id. */
  key: string;
  /** Owner's own name for it, e.g. "Hinterer Wald". */
  name: string;
  kgName?: string;
  kgNr?: string;
  gnr?: string;
  geometry: MultiPolygon;
  center: LngLat;
  areaM2: number;
  savedAt: string;
}

const STORAGE_KEY = 'forester.parcels.v1';

type Listener = (parcels: SavedParcel[]) => void;
const listeners = new Set<Listener>();

function read(): SavedParcel[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

let parcels: SavedParcel[] = read();

function write() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parcels));
  } catch (e) {
    console.error('Could not save parcels', e);
    alert('Speichern fehlgeschlagen – ist der Speicher des Browsers voll oder gesperrt?');
  }
  listeners.forEach((l) => l(parcels));
}

export const store = {
  all: () => parcels,
  get: (key: string) => parcels.find((p) => p.key === key),
  has: (key: string) => parcels.some((p) => p.key === key),
  save(p: SavedParcel) {
    parcels = [...parcels.filter((x) => x.key !== p.key), p];
    write();
  },
  rename(key: string, name: string) {
    parcels = parcels.map((p) => (p.key === key ? { ...p, name } : p));
    write();
  },
  remove(key: string) {
    parcels = parcels.filter((p) => p.key !== key);
    write();
  },
  subscribe(l: Listener) {
    listeners.add(l);
    l(parcels);
    return () => listeners.delete(l);
  },
  exportJson(): string {
    return JSON.stringify({ app: 'forester', version: 1, parcels }, null, 2);
  },
  importJson(text: string): number {
    const data = JSON.parse(text);
    const incoming: SavedParcel[] = Array.isArray(data) ? data : data?.parcels;
    if (!Array.isArray(incoming)) throw new Error('Keine Grundstücke in der Datei gefunden');
    const valid = incoming.filter((p) => p && typeof p.key === 'string' && p.geometry?.coordinates);
    const byKey = new Map(parcels.map((p) => [p.key, p]));
    valid.forEach((p) => byKey.set(p.key, p));
    parcels = [...byKey.values()];
    write();
    return valid.length;
  },
};
