// Parcels the user keeps – their own ("Meine Grundstücke") and any parcel
// they've flagged – and the groups they sort them into.
//
// Not logged in: kept on this device (localStorage).
// Logged in: kept in Supabase; every change is sent there (see `Remote`), and a
// copy is cached on the device per account so the map shows up quickly.

import type { Crop } from './crops';
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
  /** The group it's sorted into, if any. */
  groupId?: string;
  /** Detected land use ('forest', 'field'); decides whether a crop can be set. */
  landUse?: ('forest' | 'field')[];
  /** What grows there this year (fields only). */
  crop?: Crop;
}

export interface Group {
  id: string;
  name: string;
  sort: number;
}

export const isOwned = (p: SavedParcel) => p.owned !== false;

/** What's needed to keep a parcel that isn't stored yet. */
export type ParcelData = Pick<SavedParcel, 'key' | 'kgName' | 'kgNr' | 'gnr' | 'geometry' | 'center' | 'areaM2'>;

const now = () => new Date().toISOString();
const pickData = ({ key, kgName, kgNr, gnr, geometry, center, areaM2 }: ParcelData): ParcelData => ({
  key, kgName, kgNr, gnr, geometry, center, areaM2,
});
const newId = () =>
  crypto.randomUUID?.() ??
  '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16),
  );

const LOCAL_KEY = 'forester.parcels.v1';
const accountKey = (userId: string) => `forester.parcels.account.${userId}`;
const groupsKey = (key: string) => `${key}.groups`;

/** Where changes go when logged in. */
export interface Remote {
  upsert(parcels: SavedParcel[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
  upsertGroups(groups: Group[]): Promise<void>;
  removeGroups(ids: string[]): Promise<void>;
}

type Listener = (parcels: SavedParcel[]) => void;
const listeners = new Set<Listener>();
let onRemoteError: (e: Error) => void = (e) => console.error(e);

function readArray<T>(key: string): T[] {
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
let parcels: SavedParcel[] = readArray(LOCAL_KEY);
let groups: Group[] = readArray(groupsKey(LOCAL_KEY));

// Remote changes run one after another, so a new group exists before a parcel is moved into it.
let queue: Promise<unknown> = Promise.resolve();
const enqueue = (op: () => Promise<void>) => {
  queue = queue.then(op).catch((e) => onRemoteError(e));
};

function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(parcels));
    localStorage.setItem(groupsKey(storageKey), JSON.stringify(groups));
  } catch (e) {
    console.error('Could not save parcels', e);
    if (!remote) alert('Speichern fehlgeschlagen – ist der Speicher des Browsers voll oder gesperrt?');
  }
}

const notify = () => listeners.forEach((l) => l(parcels));

function diff<T>(prev: T[], next: T[], id: (x: T) => string) {
  const before = new Map(prev.map((x) => [id(x), x]));
  const ids = new Set(next.map(id));
  return {
    changed: next.filter((x) => before.get(id(x)) !== x),
    removed: prev.filter((x) => !ids.has(id(x))).map(id),
  };
}

/** Apply a change: store it, tell listeners, and send what changed to the account. */
function set(next: { parcels?: SavedParcel[]; groups?: Group[] }) {
  const prevParcels = parcels;
  const prevGroups = groups;
  if (next.parcels) parcels = next.parcels;
  if (next.groups) groups = next.groups;
  persist();
  notify();
  const r = remote;
  if (!r) return;
  const g = diff(prevGroups, groups, (x) => x.id);
  const p = diff(prevParcels, parcels, (x) => x.key);
  if (g.changed.length) enqueue(() => r.upsertGroups(g.changed));
  if (p.changed.length) enqueue(() => r.upsert(p.changed));
  if (p.removed.length) enqueue(() => r.remove(p.removed));
  if (g.removed.length) enqueue(() => r.removeGroups(g.removed));
}

const byOrder = (a: Group, b: Group) => a.sort - b.sort || a.name.localeCompare(b.name, 'de');

export const store = {
  all: () => parcels,
  get: (key: string) => parcels.find((p) => p.key === key),
  has: (key: string) => parcels.some((p) => p.key === key),
  save(p: SavedParcel) {
    set({ parcels: [...parcels.filter((x) => x.key !== p.key), p] });
  },
  rename(key: string, name: string) {
    set({ parcels: parcels.map((p) => (p.key === key ? { ...p, name } : p)) });
  },
  remove(key: string) {
    set({ parcels: parcels.filter((p) => p.key !== key) });
  },
  /** Mark as own parcel (keeps any flags and its group). */
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

  // ----- Groups -----
  groups: () => [...groups].sort(byOrder),
  group: (id?: string) => groups.find((g) => g.id === id),
  addGroup(name: string): Group {
    const g: Group = { id: newId(), name: name.trim(), sort: groups.reduce((m, x) => Math.max(m, x.sort), 0) + 1 };
    set({ groups: [...groups, g] });
    return g;
  },
  renameGroup(id: string, name: string) {
    set({ groups: groups.map((g) => (g.id === id ? { ...g, name: name.trim() } : g)) });
  },
  /** Delete a group; its parcels stay, without a group. */
  deleteGroup(id: string) {
    set({
      parcels: parcels.map((p) => (p.groupId === id ? { ...p, groupId: undefined } : p)),
      groups: groups.filter((g) => g.id !== id),
    });
  },
  setCrop(key: string, crop: Crop | undefined) {
    set({ parcels: parcels.map((p) => (p.key === key ? { ...p, crop } : p)) });
  },
  setLandUse(key: string, landUse: ('forest' | 'field')[]) {
    const cur = parcels.find((p) => p.key === key);
    if (!cur || [...(cur.landUse ?? [])].sort().join() === [...landUse].sort().join()) return;
    set({ parcels: parcels.map((p) => (p.key === key ? { ...p, landUse } : p)) });
  },
  moveToGroup(key: string, groupId: string | undefined) {
    set({ parcels: parcels.map((p) => (p.key === key ? { ...p, groupId } : p)) });
  },

  subscribe(l: Listener) {
    listeners.add(l);
    l(parcels);
    return () => listeners.delete(l);
  },

  // ----- Accounts -----
  /** Switch to an account: show its cached data now; call `loaded` once fetched. */
  useAccount(userId: string, r: Remote) {
    storageKey = accountKey(userId);
    remote = undefined; // the cache isn't a change to send
    parcels = readArray(storageKey);
    groups = readArray(groupsKey(storageKey));
    notify();
    return {
      loaded(fromServer: { parcels: SavedParcel[]; groups: Group[] }) {
        parcels = fromServer.parcels;
        groups = fromServer.groups;
        persist();
        remote = r;
        notify();
      },
    };
  },
  /** Replace parcels with a fresh copy from the account (e.g. after the server changed flags). */
  reloaded(fromServer: SavedParcel[]) {
    parcels = fromServer;
    persist();
    notify();
  },
  /** Back to the data kept on this device without an account. */
  useLocal() {
    storageKey = LOCAL_KEY;
    remote = undefined;
    parcels = readArray(LOCAL_KEY);
    groups = readArray(groupsKey(LOCAL_KEY));
    notify();
  },
  /** Data saved on this device without an account (to offer uploading it). */
  deviceData: () => ({ parcels: readArray<SavedParcel>(LOCAL_KEY), groups: readArray<Group>(groupsKey(LOCAL_KEY)) }),
  clearDeviceData() {
    localStorage.removeItem(LOCAL_KEY);
    localStorage.removeItem(groupsKey(LOCAL_KEY));
  },
  /** Add parcels and groups to the current account; keeps the account's version where both exist. */
  addMissing(incoming: { parcels: SavedParcel[]; groups?: Group[] }) {
    const haveGroups = new Set(groups.map((g) => g.id));
    const addGroups = (incoming.groups ?? []).filter((g) => !haveGroups.has(g.id));
    const allGroupIds = new Set([...haveGroups, ...addGroups.map((g) => g.id)]);
    const have = new Set(parcels.map((p) => p.key));
    const add = incoming.parcels
      .filter((p) => !have.has(p.key))
      .map((p) => (p.groupId && !allGroupIds.has(p.groupId) ? { ...p, groupId: undefined } : p));
    if (add.length || addGroups.length) set({ parcels: [...parcels, ...add], groups: [...groups, ...addGroups] });
    return add.length;
  },
  onRemoteError(fn: (e: Error) => void) {
    onRemoteError = fn;
  },
  exportJson(): string {
    return JSON.stringify({ app: 'forester', version: 2, parcels, groups }, null, 2);
  },
  importJson(text: string): number {
    const data = JSON.parse(text);
    const incoming: SavedParcel[] = Array.isArray(data) ? data : data?.parcels;
    if (!Array.isArray(incoming)) throw new Error('Keine Grundstücke in der Datei gefunden');
    const valid = incoming.filter((p) => p && typeof p.key === 'string' && p.geometry?.coordinates);
    const inGroups: Group[] = Array.isArray(data?.groups) ? data.groups.filter((g: Group) => g?.id && g?.name) : [];
    const groupMap = new Map(groups.map((g) => [g.id, g]));
    inGroups.forEach((g) => groupMap.set(g.id, g));
    const byKey = new Map(parcels.map((p) => [p.key, p]));
    valid.forEach((p) => byKey.set(p.key, p.groupId && !groupMap.has(p.groupId) ? { ...p, groupId: undefined } : p));
    set({ parcels: [...byKey.values()], groups: [...groupMap.values()] });
    return valid.length;
  },
};
