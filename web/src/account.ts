// User accounts (Supabase Auth) and syncing parcels to the database.
// Schema: supabase/migrations/. Signup needs an invite code, except for the
// very first account, which becomes admin.

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Flag } from './flags';
import type { Remote, SavedParcel } from './store';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False when the app is built without Supabase settings: accounts are then hidden. */
export const accountsEnabled = !!(URL && KEY);

let client: SupabaseClient | undefined;
const sb = () => (client ??= createClient(URL!, KEY!, { auth: { persistSession: true, autoRefreshToken: true } }));

export interface Profile {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
}

export interface Invite {
  code: string;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

// ---------- Errors in plain German ----------
function friendly(e: unknown): Error {
  const msg = (e as { message?: string })?.message ?? String(e);
  if (/Invalid login credentials/i.test(msg)) return new Error('E-Mail oder Passwort falsch.');
  if (/already registered|already exists/i.test(msg)) return new Error('Für diese E-Mail gibt es schon ein Konto. Bitte anmelden.');
  if (/Database error saving new user|INVITE_INVALID/i.test(msg))
    return new Error('Der Einladungslink ist ungültig, abgelaufen oder wurde schon verwendet.');
  if (/Password should be at least/i.test(msg)) return new Error('Das Passwort ist zu kurz (mindestens 6 Zeichen).');
  if (/valid email|invalid format/i.test(msg)) return new Error('Bitte eine gültige E-Mail-Adresse eingeben.');
  if (/Email not confirmed/i.test(msg)) return new Error('E-Mail noch nicht bestätigt – bitte den Admin fragen.');
  if (/Failed to fetch|NetworkError/i.test(msg)) return new Error('Keine Verbindung zum Server.');
  return new Error(msg);
}

// ---------- Session ----------
export async function currentSession(): Promise<Session | null> {
  if (!accountsEnabled) return null;
  const { data } = await sb().auth.getSession();
  return data.session;
}

export function onAuthChange(fn: (session: Session | null) => void) {
  if (!accountsEnabled) return;
  sb().auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') fn(session);
  });
}

export async function signIn(email: string, password: string) {
  const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw friendly(error);
}

export async function signUp(opts: { email: string; password: string; displayName: string; inviteCode?: string }) {
  const { data, error } = await sb().auth.signUp({
    email: opts.email.trim(),
    password: opts.password,
    options: { data: { display_name: opts.displayName.trim(), invite_code: opts.inviteCode ?? '' } },
  });
  if (error) throw friendly(error);
  if (!data.session)
    throw new Error('Konto erstellt, aber nicht angemeldet. Ist die E-Mail-Bestätigung in Supabase noch eingeschaltet?');
}

export async function signOut() {
  await sb().auth.signOut();
}

export async function loadProfile(session: Session): Promise<Profile> {
  const { data, error } = await sb().from('profiles').select('display_name, is_admin').eq('id', session.user.id).maybeSingle();
  if (error) throw friendly(error);
  return {
    id: session.user.id,
    email: session.user.email ?? '',
    displayName: data?.display_name ?? '',
    isAdmin: !!data?.is_admin,
  };
}

// ---------- Invites ----------
export async function checkInvite(code: string): Promise<boolean> {
  const { data, error } = await sb().rpc('check_invite', { invite_code: code });
  if (error) throw friendly(error);
  return data === true;
}

export async function createInvite(note: string): Promise<Invite> {
  const { data, error } = await sb()
    .from('invites')
    .insert({ note: note.trim() || null })
    .select('code, note, created_at, expires_at, used_at')
    .single();
  if (error) throw friendly(error);
  return toInvite(data);
}

export async function listInvites(): Promise<Invite[]> {
  const { data, error } = await sb()
    .from('invites')
    .select('code, note, created_at, expires_at, used_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw friendly(error);
  return (data ?? []).map(toInvite);
}

export async function deleteInvite(code: string) {
  const { error } = await sb().from('invites').delete().eq('code', code);
  if (error) throw friendly(error);
}

const toInvite = (r: { code: string; note: string | null; created_at: string; expires_at: string; used_at: string | null }): Invite => ({
  code: r.code,
  note: r.note,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
});

export const inviteUrl = (code: string) => {
  const url = new window.URL(import.meta.env.BASE_URL, location.origin);
  url.searchParams.set('invite', code);
  return url.toString();
};

// ---------- Parcels ----------
interface ParcelRow {
  key: string;
  name: string;
  kg_nr: string | null;
  kg_name: string | null;
  gnr: string | null;
  owned: boolean;
  flags: Flag[];
  geometry: SavedParcel['geometry'];
  center: SavedParcel['center'];
  area_m2: number;
  saved_at: string;
}

const toRow = (p: SavedParcel, userId: string) => ({
  user_id: userId,
  key: p.key,
  name: p.name,
  kg_nr: p.kgNr ?? null,
  kg_name: p.kgName ?? null,
  gnr: p.gnr ?? null,
  owned: p.owned !== false,
  flags: p.flags ?? [],
  geometry: p.geometry,
  center: p.center,
  area_m2: p.areaM2,
  saved_at: p.savedAt,
});

const fromRow = (r: ParcelRow): SavedParcel => ({
  key: r.key,
  name: r.name,
  kgNr: r.kg_nr ?? undefined,
  kgName: r.kg_name ?? undefined,
  gnr: r.gnr ?? undefined,
  owned: r.owned,
  flags: r.flags ?? [],
  geometry: r.geometry,
  center: r.center,
  areaM2: r.area_m2,
  savedAt: r.saved_at,
});

export async function loadParcels(): Promise<SavedParcel[]> {
  const { data, error } = await sb()
    .from('parcels')
    .select('key, name, kg_nr, kg_name, gnr, owned, flags, geometry, center, area_m2, saved_at');
  if (error) throw friendly(error);
  return (data as ParcelRow[]).map(fromRow);
}

export function parcelRemote(userId: string): Remote {
  return {
    async upsert(parcels) {
      const { error } = await sb()
        .from('parcels')
        .upsert(parcels.map((p) => toRow(p, userId)), { onConflict: 'user_id,key' });
      if (error) throw friendly(error);
    },
    async remove(keys) {
      const { error } = await sb().from('parcels').delete().eq('user_id', userId).in('key', keys);
      if (error) throw friendly(error);
    },
  };
}
