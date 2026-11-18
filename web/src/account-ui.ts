// Account panel: login, signup with invite, profile + invite links (admins).

import type { Session } from '@supabase/supabase-js';
import {
  accountsEnabled,
  checkInvite,
  createInvite,
  currentSession,
  deleteInvite,
  deleteShare,
  listShares,
  shareUrl,
  type ShareInfo,
  inviteUrl,
  listInvites,
  loadGroups,
  loadParcels,
  loadProfile,
  onAuthChange,
  parcelRemote,
  signIn,
  signOut,
  signUp,
  type Invite,
  type Profile,
} from './account';
import { store } from './store';

type View = 'login' | 'signup' | 'profile';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (iso: string) => new Date(iso).toLocaleDateString('de-AT');

export function initAccount(opts: {
  onOpen: () => void;
  onChange: () => void;
  beforeLogout?: () => Promise<void>;
  toast: (msg: string) => void;
}) {
  const panel = document.getElementById('account') as HTMLElement;
  let view: View = 'login';
  let profile: Profile | undefined;
  let userId: string | undefined;
  let invites: Invite[] = [];
  let shares: ShareInfo[] = [];
  let newInvite: Invite | undefined;
  let error = '';
  let busy = false;
  let inviteCode = new URLSearchParams(location.search).get('invite') ?? '';
  let inviteValid: boolean | undefined;

  store.onRemoteError((e) => opts.toast(`Nicht gespeichert: ${e.message}`));

  // ----- Session handling -----
  async function start(session: Session | null) {
    if (!session) {
      if (!userId) return;
      userId = undefined;
      profile = undefined;
      store.useLocal();
      opts.onChange();
      render();
      return;
    }
    if (session.user.id === userId) return;
    userId = session.user.id;
    const sw = store.useAccount(userId, parcelRemote(userId));
    try {
      profile = await loadProfile(session);
    } catch {
      profile = { id: userId, email: session.user.email ?? '', displayName: '', isAdmin: false };
    }
    opts.onChange();
    try {
      const [parcels, groups] = await Promise.all([loadParcels(), loadGroups()]);
      sw.loaded({ parcels, groups });
    } catch (e) {
      opts.toast(`Grundstücke konnten nicht geladen werden: ${(e as Error).message}`);
      sw.loaded({ parcels: store.all(), groups: store.groups() });
    }
    offerDeviceParcels();
    if (view !== 'profile' && !panel.hidden) view = 'profile';
    render();
  }

  function offerDeviceParcels() {
    const local = store.deviceData();
    if (!local.parcels.length) return;
    const ok = confirm(
      `Auf diesem Gerät sind ${local.parcels.length} Grundstück(e) ohne Konto gespeichert. In dein Konto übernehmen?`,
    );
    if (!ok) return;
    const added = store.addMissing(local);
    store.clearDeviceData();
    opts.toast(`${added} Grundstück(e) ins Konto übernommen.`);
  }

  // ----- Rendering -----
  function render() {
    if (panel.hidden) return;
    const head = (title: string) => `
      <div class="drawer-head">
        <h2>${title}</h2>
        <button type="button" class="icon" data-acc="close" aria-label="Schließen">✕</button>
      </div>`;
    const err = error ? `<p class="form-error" role="alert">${esc(error)}</p>` : '';

    if (profile) {
      const inviteBlock = profile.isAdmin
        ? `
        <h3>Einladungen</h3>
        <form class="form" data-form="invite">
          <label>Für wen? <span class="optional">(optional, nur als Notiz)</span>
            <input name="note" type="text" maxlength="80" placeholder="z. B. Nachbar Huber" /></label>
          <button type="submit" class="primary" ${busy ? 'disabled' : ''}>Einladungslink erstellen</button>
        </form>
        ${
          newInvite
            ? `<div class="invite-new">
                <p>Neuer Link${newInvite.note ? ` für ${esc(newInvite.note)}` : ''}, gültig bis ${date(newInvite.expiresAt)}, einmal verwendbar:</p>
                <input type="text" readonly value="${esc(inviteUrl(newInvite.code))}" data-acc="select" />
                <div class="sheet-actions">
                  <button type="button" data-acc="copy" data-code="${newInvite.code}">Kopieren</button>
                  ${'share' in navigator ? `<button type="button" data-acc="share" data-code="${newInvite.code}">Teilen</button>` : ''}
                </div>
              </div>`
            : ''
        }
        <ul class="invite-list">${invites
          .map((i) => {
            const status = i.usedAt
              ? `verwendet am ${date(i.usedAt)}`
              : new Date(i.expiresAt) < new Date()
                ? 'abgelaufen'
                : `offen bis ${date(i.expiresAt)}`;
            return `<li><div><strong>${esc(i.note || 'Einladung')}</strong><span>${status}</span></div>
              ${
                !i.usedAt
                  ? `<span class="invite-actions">
                      ${new Date(i.expiresAt) > new Date() ? `<button type="button" class="icon" data-acc="copy" data-code="${i.code}" aria-label="Link kopieren" title="Link kopieren">⧉</button>` : ''}
                      <button type="button" class="icon" data-acc="delete-invite" data-code="${i.code}" aria-label="Löschen" title="Löschen">🗑</button>
                    </span>`
                  : ''
              }</li>`;
          })
          .join('')}</ul>`
        : '';
      panel.innerHTML = `${head('Konto')}
        <p class="account-who"><strong>${esc(profile.displayName || profile.email)}</strong>
          ${profile.displayName ? `<span>${esc(profile.email)}</span>` : ''}
          ${profile.isAdmin ? '<i class="pill" style="--c:#1b5e20">Admin</i>' : ''}</p>
        <p class="fineprint">${store.all().length} Grundstück(e) im Konto gespeichert – auf allen Geräten verfügbar.</p>
        ${err}
        ${
          shares.length
            ? `<h3>Geteilte Listen</h3>
              <ul class="share-list">${shares
                .map(
                  (sh) => `<li><div><strong>${esc(sh.title)}</strong>
                    <span>${sh.count} Grundstück(e) · gültig bis ${date(sh.expiresAt)}</span></div>
                    <span class="invite-actions">
                      <button type="button" class="icon" data-acc="copy-share" data-token="${sh.token}" aria-label="Link kopieren" title="Link kopieren">⧉</button>
                      <button type="button" class="icon" data-acc="delete-share" data-token="${sh.token}" aria-label="Löschen" title="Löschen">🗑</button>
                    </span></li>`,
                )
                .join('')}</ul>`
            : ''
        }
        ${inviteBlock}
        <div class="sheet-actions"><button type="button" data-acc="logout">Abmelden</button></div>`;
      return;
    }

    if (view === 'signup') {
      const codeNote =
        inviteCode && inviteValid === false
          ? `<p class="form-error">Dieser Einladungslink ist ungültig, abgelaufen oder wurde schon verwendet.</p>`
          : inviteCode && inviteValid
            ? `<p class="form-ok">Einladung gültig ✓</p>`
            : '';
      panel.innerHTML = `${head('Konto erstellen')}
        ${codeNote}
        <form class="form" data-form="signup">
          <label>Name <input name="name" type="text" autocomplete="name" required maxlength="60" /></label>
          <label>E-Mail <input name="email" type="email" autocomplete="email" required /></label>
          <label>Passwort <input name="password" type="password" autocomplete="new-password" minlength="6" required /></label>
          <label>Einladungscode <input name="code" type="text" value="${esc(inviteCode)}" autocomplete="off" spellcheck="false" /></label>
          ${err}
          <button type="submit" class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Bitte warten…' : 'Konto erstellen'}</button>
        </form>
        <p class="fineprint">Schon ein Konto? <a href="#" data-acc="to-login">Anmelden</a></p>`;
      return;
    }

    panel.innerHTML = `${head('Anmelden')}
      <form class="form" data-form="login">
        <label>E-Mail <input name="email" type="email" autocomplete="email" required /></label>
        <label>Passwort <input name="password" type="password" autocomplete="current-password" required /></label>
        ${err}
        <button type="submit" class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Bitte warten…' : 'Anmelden'}</button>
      </form>
      <p class="fineprint">Mit Konto sind deine Grundstücke und Markierungen auf allen Geräten verfügbar.
        Ein Konto gibt es nur mit Einladungslink. <a href="#" data-acc="to-signup">Konto erstellen</a></p>`;
  }

  async function refreshShares() {
    try {
      shares = await listShares();
    } catch {
      /* not critical */
    }
    render();
  }

  async function refreshInvites() {
    if (!profile?.isAdmin) return;
    try {
      invites = await listInvites();
    } catch (e) {
      error = (e as Error).message;
    }
    render();
  }

  function open(v?: View) {
    if (!accountsEnabled) {
      panel.hidden = true; // app built without Supabase: no accounts
      return;
    }
    error = '';
    if (v) view = v;
    if (profile) view = 'profile';
    panel.hidden = false;
    opts.onOpen();
    render();
    if (profile?.isAdmin) void refreshInvites();
    if (profile) void refreshShares();
    // Only jump into the form when opened for signup (invite link), not on every visit
    if (v === 'signup') panel.querySelector<HTMLInputElement>('input:not([readonly])')?.focus();
  }

  // ----- Events -----
  panel.addEventListener('click', async (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-acc]');
    if (!el) return;
    const act = el.dataset.acc;
    if (el.tagName === 'A') e.preventDefault();
    if (act === 'close') panel.hidden = true;
    else if (act === 'to-login') { view = 'login'; error = ''; render(); }
    else if (act === 'to-signup') { view = 'signup'; error = ''; render(); }
    else if (act === 'select') (el as HTMLInputElement).select();
    else if (act === 'logout') {
      await opts.beforeLogout?.().catch(() => {});
      await signOut();
      newInvite = undefined;
      invites = [];
      view = 'login';
      await start(null);
      opts.toast('Abgemeldet. Ohne Konto wird nur auf diesem Gerät gespeichert.');
    } else if (act === 'copy' && el.dataset.code) {
      const url = inviteUrl(el.dataset.code);
      try {
        await navigator.clipboard.writeText(url);
        opts.toast('Link kopiert.');
      } catch {
        prompt('Link kopieren:', url);
      }
    } else if (act === 'share' && el.dataset.code) {
      navigator.share?.({ title: 'Einladung zu Forester', text: 'Hier ist dein Einladungslink für Forester:', url: inviteUrl(el.dataset.code) }).catch(() => {});
    } else if (act === 'copy-share' && el.dataset.token) {
      const url = shareUrl(el.dataset.token);
      try {
        await navigator.clipboard.writeText(url);
        opts.toast('Link kopiert.');
      } catch {
        prompt('Link kopieren:', url);
      }
    } else if (act === 'delete-share' && el.dataset.token) {
      if (!confirm('Diese geteilte Liste löschen? Der Link funktioniert dann nicht mehr.')) return;
      try {
        await deleteShare(el.dataset.token);
        await refreshShares();
      } catch (err) {
        error = (err as Error).message;
        render();
      }
    } else if (act === 'delete-invite' && el.dataset.code) {
      if (!confirm('Diese Einladung löschen? Der Link funktioniert dann nicht mehr.')) return;
      try {
        await deleteInvite(el.dataset.code);
        if (newInvite?.code === el.dataset.code) newInvite = undefined;
        await refreshInvites();
      } catch (err) {
        error = (err as Error).message;
        render();
      }
    }
  });

  panel.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const f = Object.fromEntries(new FormData(form)) as Record<string, string>;
    error = '';
    busy = true;
    render();
    try {
      if (form.dataset.form === 'login') {
        await signIn(f.email, f.password);
        await start(await currentSession());
      } else if (form.dataset.form === 'signup') {
        const code = f.code.trim();
        inviteCode = code;
        await signUp({ email: f.email, password: f.password, displayName: f.name, inviteCode: code });
        // Drop ?invite= from the address
        const url = new URL(location.href);
        url.searchParams.delete('invite');
        history.replaceState(null, '', url);
        await start(await currentSession());
        opts.toast('Willkommen! Dein Konto ist eingerichtet.');
      } else if (form.dataset.form === 'invite') {
        newInvite = await createInvite(f.note ?? '');
        await refreshInvites();
      }
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
      render();
    }
  });

  // ----- Start -----
  if (accountsEnabled) {
    void currentSession().then(async (s) => {
      await start(s);
      if (inviteCode) {
        if (profile) {
          opts.toast('Du bist schon angemeldet – der Einladungslink wird nicht gebraucht.');
        } else {
          inviteValid = await checkInvite(inviteCode).catch(() => undefined);
          open('signup');
        }
      }
    });
    onAuthChange((s) => void start(s));
  }

  return {
    enabled: accountsEnabled,
    open: () => open(),
    profile: () => profile,
    close: () => (panel.hidden = true),
  };
}
