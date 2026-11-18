// Parcels the user keeps: their own ("Meine Grundstücke") and any parcel
// they've flagged.
//
// Not logged in: kept on this device (localStorage).
// Logged in: kept in Supabase; every change is sent there (see `Remote`), and a
// copy is cached on the device per account so the map shows up quickly.

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

const LOCAL_KEY = 'forester.parcels.v1';
const accountKey = (userId: string) => `forester.parcels.account.${userId}`;

/** Where changes go when logged in. */
export interface Remote {
  upsert(parcels: SavedParcel[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

type Listener = (parcels: SavedParcel[]) => void;
const listeners = new Set<Listener>();
let onRemoteError: (e: Error) => void = (e) => console.error(e);

function readKey(key: string): SavedParcel[] {
  try {
    const raw = localStorage.getItem(key);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

let storageKey = LOCAL_KEY;
let remote: Remote | undefined;
let parcels: SavedParcel[] = readKey(LOCAL_KEY);

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(parcels));
  } catch (e) {
    console.error('Could not save parcels', e);
    if (!remote) alert('Speichern fehlgeschlagen – ist der Speicher des Browsers voll oder gesperrt?');
  }
}

/** Apply a change: store it, tell listeners, and send what changed to the account. */
function write(prev: SavedParcel[] = parcels) {
  persist();
  listeners.forEach((l) => l(parcels));
  if (!remote) return;
  const before = new Map(prev.map((p) => [p.key, p]));
  const changed = parcels.filter((p) => before.get(p.key) !== p);
  const keys = new Set(parcels.map((p) => p.key));
  const removed = prev.filter((p) => !keys.has(p.key)).map((p) => p.key);
  if (changed.length) remote.upsert(changed).catch(onRemoteError);
  if (removed.length) remote.remove(removed).catch(onRemoteError);
}

function set(next: SavedParcel[]) {
  const prev = parcels;
  parcels = next;
  write(prev);
}

export const store = {
  all: () => parcels,
  get: (key: string) => parcels.find((p) => p.key === key),
  has: (key: string) => parcels.some((p) => p.key === key),
  save(p: SavedParcel) {
    set([...parcels.filter((x) => x.key !== p.key), p]);
  },
  rename(key: string, name: string) {
    set(parcels.map((p) => (p.key === key ? { ...p, name } : p)));
  },
  remove(key: string) {
    set(parcels.filter((p) => p.key !== key));
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
  // ----- Accounts -----
  /** Switch to an account: show its cached parcels now; call `loaded` once fetched. */
  useAccount(userId: string, r: Remote) {
    storageKey = accountKey(userId);
    remote = undefined; // the cache isn't a change to send
    parcels = readKey(storageKey);
    listeners.forEach((l) => l(parcels));
    return {
      loaded(fromServer: SavedParcel[]) {
        parcels = fromServer;
        persist();
        remote = r;
        listeners.forEach((l) => l(parcels));
      },
    };
  },
  /** Replace with a fresh copy from the account (e.g. after the server changed flags). */
  reloaded(fromServer: SavedParcel[]) {
    parcels = fromServer;
    persist();
    listeners.forEach((l) => l(parcels));
  },
  /** Back to the parcels kept on this device without an account. */
  useLocal() {
    storageKey = LOCAL_KEY;
    remote = undefined;
    parcels = readKey(LOCAL_KEY);
    listeners.forEach((l) => l(parcels));
  },
  /** Parcels saved on this device without an account (to offer uploading them). */
  deviceParcels: () => readKey(LOCAL_KEY),
  clearDeviceParcels() {
    localStorage.removeItem(LOCAL_KEY);
  },
  /** Add parcels to the current account; keeps the account's version where both exist. */
  addMissing(incoming: SavedParcel[]) {
    const have = new Set(parcels.map((p) => p.key));
    const add = incoming.filter((p) => !have.has(p.key));
    if (add.length) set([...parcels, ...add]);
    return add.length;
  },
  onRemoteError(fn: (e: Error) => void) {
    onRemoteError = fn;
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
    set([...byKey.values()]);
    return valid.length;
  },
};
