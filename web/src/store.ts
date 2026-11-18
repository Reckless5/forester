// Parcels the user keeps: their own ("Meine Grundstücke") and any parcel
// they've flagged. Saved on this device for now (localStorage).
// Later this moves to a backend so owners can use several devices.

import { sortFlags, type Flag, type FlagType } from './flags';
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
  /** False for a parcel that's only kept because it's flagged. Missing = true (older data). */
  owned?: boolean;
  flags?: Flag[];
}

export const isOwned = (p: SavedParcel) => p.owned !== false;

/** What's needed to keep a parcel that isn't stored yet. */
export type ParcelData = Pick<SavedParcel, 'key' | 'kgName' | 'kgNr' | 'gnr' | 'geometry' | 'center' | 'areaM2'>;

const now = () => new Date().toISOString();
const pickData = ({ key, kgName, kgNr, gnr, geometry, center, areaM2 }: ParcelData): ParcelData => ({
  key, kgName, kgNr, gnr, geometry, center, areaM2,
});

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
  /** Mark as own parcel (keeps any flags). */
  own(data: ParcelData, name: string): SavedParcel {
    const cur = parcels.find((p) => p.key === data.key);
    const p: SavedParcel = { ...cur, ...pickData(data), name, owned: true, savedAt: cur?.savedAt ?? now() };
    this.save(p);
    return p;
  },
  /** No longer own: dropped entirely unless it still has flags. */
  disown(key: string) {
    const cur = parcels.find((p) => p.key === key);
    if (!cur) return;
    if (cur.flags?.length) this.save({ ...cur, owned: false });
    else this.remove(key);
  },
  /** Turn a flag on or off. Returns the stored parcel, or undefined if it was dropped. */
  toggleFlag(data: ParcelData, type: FlagType, fallbackName: string): SavedParcel | undefined {
    const cur = parcels.find((p) => p.key === data.key);
    const flags = cur?.flags ?? [];
    const next = flags.some((f) => f.type === type)
      ? flags.filter((f) => f.type !== type)
      : sortFlags([...flags, { type, since: now() }]);
    if (!next.length && cur && !isOwned(cur)) {
      this.remove(data.key);
      return undefined;
    }
    const p: SavedParcel = cur
      ? { ...cur, flags: next }
      : { ...pickData(data), name: fallbackName, owned: false, savedAt: now(), flags: next };
    this.save(p);
    return p;
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
