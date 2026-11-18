// User accounts (Supabase Auth) and syncing parcels to the database.
// Schema: supabase/migrations/. Signup needs an invite code, except for the
// very first account, which becomes admin.

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { Flag } from './flags';
import type { Group, Remote, SavedParcel } from './store';

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
  group_id: string | null;
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
  group_id: p.groupId ?? null,
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
  groupId: r.group_id ?? undefined,
});

export async function loadParcels(): Promise<SavedParcel[]> {
  const { data, error } = await sb()
    .from('parcels')
    .select('key, name, kg_nr, kg_name, gnr, owned, flags, geometry, center, area_m2, saved_at, group_id');
  if (error) throw friendly(error);
  return (data as ParcelRow[]).map(fromRow);
}

export async function loadGroups(): Promise<Group[]> {
  const { data, error } = await sb().from('parcel_groups').select('id, name, sort');
  if (error) throw friendly(error);
  return (data ?? []) as Group[];
}

export function parcelRemote(userId: string): Remote {
  return {
    async upsertGroups(groups) {
      const { error } = await sb()
        .from('parcel_groups')
        .upsert(groups.map((g) => ({ id: g.id, user_id: userId, name: g.name, sort: g.sort })), { onConflict: 'id' });
      if (error) throw friendly(error);
    },
    async removeGroups(ids) {
      const { error } = await sb().from('parcel_groups').delete().eq('user_id', userId).in('id', ids);
      if (error) throw friendly(error);
    },
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

// ---------- Shared lists ----------
export interface SharedList {
  title: string;
  createdAt: string;
  expiresAt: string;
  ownerName: string;
  parcels: SavedParcel[];
}

export interface ShareInfo {
  token: string;
  title: string;
  count: number;
  createdAt: string;
  expiresAt: string;
}

export const shareUrl = (token: string) => {
  const url = new window.URL(import.meta.env.BASE_URL, location.origin);
  url.searchParams.set('share', token);
  return url.toString();
};

/** Snapshot of the given parcels that anyone with the link can open. */
export async function createShare(title: string, parcels: SavedParcel[], recipientId?: string): Promise<string> {
  const snapshot = parcels.map(({ key, name, kgNr, kgName, gnr, flags, geometry, center, areaM2, owned }) => ({
    key, name, kgNr, kgName, gnr, flags, geometry, center, areaM2, owned,
  }));
  const { data, error } = await sb()
    .from('shares')
    .insert({ title, parcels: snapshot, recipient_id: recipientId ?? null })
    .select('token')
    .single();
  if (error) throw friendly(error);
  return data.token as string;
}

export async function getShare(token: string): Promise<SharedList | null> {
  const { data, error } = await sb().rpc('get_share', { share_token: token });
  if (error) throw friendly(error);
  return (data as SharedList | null) ?? null;
}

export async function listShares(): Promise<ShareInfo[]> {
  const { data, error } = await sb()
    .from('shares')
    .select('token, title, parcels, created_at, expires_at')
    .is('recipient_id', null)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw friendly(error);
  return (data ?? []).map((r) => ({
    token: r.token,
    title: r.title,
    count: Array.isArray(r.parcels) ? r.parcels.length : 0,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

export async function deleteShare(token: string) {
  const { error } = await sb().from('shares').delete().eq('token', token);
  if (error) throw friendly(error);
}

// ---------- Flag reports (others flagged one of my parcels) ----------
export interface FlagReport {
  id: string;
  parcelKey: string;
  parcelName: string | null;
  flagType: Flag['type'];
  reporterName: string | null;
  createdAt: string;
}

export async function listPendingReports(): Promise<FlagReport[]> {
  const { data, error } = await sb()
    .from('flag_reports')
    .select('id, parcel_key, parcel_name, flag_type, reporter_name, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw friendly(error);
  return (data ?? []).map((r) => ({
    id: r.id,
    parcelKey: r.parcel_key,
    parcelName: r.parcel_name,
    flagType: r.flag_type,
    reporterName: r.reporter_name,
    createdAt: r.created_at,
  }));
}

export async function resolveReport(id: string, accept: boolean) {
  const { error } = await sb().rpc('resolve_flag_report', { report_id: id, accept });
  if (error) throw friendly(error);
}

// ---------- Push ----------
export const notifyFunctionUrl = () => `${URL}/functions/v1/notify-flag-report`;
export const supabaseKey = () => KEY!;

export async function registerPush(sub: PushSubscription) {
  const json = sub.toJSON();
  const { error } = await sb().rpc('register_push', {
    sub_endpoint: sub.endpoint,
    sub_p256dh: json.keys?.p256dh ?? '',
    sub_auth: json.keys?.auth ?? '',
  });
  if (error) throw friendly(error);
}

export async function unregisterPush(endpoint: string) {
  const { error } = await sb().from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) throw friendly(error);
}

// ---------- Sending to other members ----------
export interface Member {
  id: string;
  displayName: string;
}

export async function listMembers(): Promise<Member[]> {
  const { data, error } = await sb().rpc('list_members');
  if (error) throw friendly(error);
  return (data ?? []).map((m: { id: string; display_name: string }) => ({ id: m.id, displayName: m.display_name }));
}

export interface Received {
  token: string;
  title: string;
  count: number;
  fromName: string;
  createdAt: string;
  seen: boolean;
}

export async function listReceived(): Promise<Received[]> {
  const { data, error } = await sb().rpc('received_shares');
  if (error) throw friendly(error);
  return (data ?? []).map(
    (r: { token: string; title: string; item_count: number; from_name: string; created_at: string; seen: boolean }) => ({
      token: r.token,
      title: r.title,
      count: r.item_count,
      fromName: r.from_name,
      createdAt: r.created_at,
      seen: r.seen,
    }),
  );
}

export async function markReceivedSeen(token: string) {
  await sb().rpc('mark_share_seen', { share_token: token });
}

export async function deleteReceived(token: string) {
  const { error } = await sb().from('shares').delete().eq('token', token);
  if (error) throw friendly(error);
}
