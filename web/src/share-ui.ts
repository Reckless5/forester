// Sharing a list of parcels by link, and showing a list someone shared (?share=…).

import { accountsEnabled, createShare, getShare, listMembers, shareUrl, type SharedList } from './account';
import { choose } from './dialog';
import { cropText } from './crops';
import { flagDef, sortFlags } from './flags';
import { formatArea, type LngLat } from './geo';
import type { SavedParcel } from './store';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const parcelLine = (p: SavedParcel) => {
  const flags = [p.crop ? cropText(p.crop) : '', ...sortFlags(p.flags).map((f) => flagDef(f.type).label)]
    .filter(Boolean)
    .join(', ');
  const where = [p.gnr ? `Gst. ${p.gnr}` : '', p.kgName ? `KG ${p.kgName}` : ''].filter(Boolean).join(', ');
  const name = p.name && p.name !== `Gst. ${p.gnr}` ? `${p.name} – ` : '';
  return `• ${name}${where}${flags ? ` – ${flags}` : ''}`;
};

/** Send parcels (a group or a single one) to another member; they find it under "Erhalten". */
export async function sendToMember(
  parcels: SavedParcel[],
  title: string,
  opts: { isLoggedIn: boolean; toast: (m: string) => void },
) {
  if (!accountsEnabled || !opts.isLoggedIn) {
    opts.toast('Zum Senden bitte anmelden (Mehr → Anmelden).');
    return;
  }
  if (!parcels.length) {
    opts.toast('Da ist nichts zum Senden.');
    return;
  }
  try {
    const members = await listMembers();
    const id = await choose(
      `„${title}“ senden an …`,
      members.map((m) => ({ id: m.id, label: m.displayName })),
      {
        search: members.length > 6,
        hint: `${parcels.length} Grundstück${parcels.length === 1 ? '' : 'e'}. Die Person bekommt eine Nachricht und findet es in der Übersicht unter „Erhalten“.`,
        empty: 'Noch keine anderen Mitglieder. Lade jemanden ein (Mehr → Einladungen).',
      },
    );
    if (!id) return;
    await createShare(title, parcels, id);
    opts.toast(`An ${members.find((m) => m.id === id)?.displayName ?? 'Mitglied'} gesendet.`);
  } catch (e) {
    opts.toast((e as Error).message);
  }
}

/** Create a link for these parcels and hand it to the phone's share sheet (or copy it). */
export async function shareParcels(
  parcels: SavedParcel[],
  defaultTitle: string,
  opts: { isLoggedIn: boolean; toast: (m: string) => void; askTitle?: boolean },
) {
  if (!accountsEnabled || !opts.isLoggedIn) {
    opts.toast('Zum Teilen bitte anmelden (☰ → Anmelden).');
    return;
  }
  if (!parcels.length) {
    opts.toast('Die Liste ist leer.');
    return;
  }
  const title = opts.askTitle === false ? defaultTitle : prompt('Titel der Liste:', defaultTitle)?.trim();
  if (!title) return;
  try {
    const url = shareUrl(await createShare(title, parcels));
    const lines = parcels.slice(0, 30).map(parcelLine);
    if (parcels.length > 30) lines.push(`… und ${parcels.length - 30} weitere`);
    const text = `${title} (${parcels.length} Grundstück${parcels.length === 1 ? '' : 'e'}):\n${lines.join('\n')}\n\nAuf der Karte ansehen:`;
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      opts.toast('Link und Liste kopiert – zum Senden einfügen.');
    } catch {
      prompt('Link kopieren:', url);
    }
  } catch (e) {
    opts.toast((e as Error).message);
  }
}

/** Panel showing a shared list; the parcels are drawn in their own map layer. */
export function initSharedView(opts: {
  setShared: (parcels: SavedParcel[]) => void;
  fitAll: (parcels: SavedParcel[]) => void;
  showParcel: (p: SavedParcel) => void;
  relativeTo: (p: SavedParcel) => string;
  onOpen: () => void;
  toast: (m: string) => void;
}) {
  const panel = document.getElementById('shared') as HTMLElement;
  let list: SharedList | undefined;

  function render() {
    if (!list) return;
    const parcels = list.parcels;
    panel.innerHTML = `
      <div class="drawer-head">
        <div>
          <h2>${esc(list.title)}</h2>
          <p class="fineprint">Geteilt von ${esc(list.ownerName)} · ${parcels.length} Grundstück${parcels.length === 1 ? '' : 'e'} ·
            ${new Date(list.createdAt).toLocaleDateString('de-AT')}</p>
        </div>
        <button type="button" class="icon" data-sh="close" aria-label="Schließen">✕</button>
      </div>
      <ul class="mine-list">${parcels
        .map((p, i) => {
          const flags =
            (p.crop ? `<i class="pill pill-crop">${esc(cropText(p.crop))}</i>` : '') +
            sortFlags(p.flags)
              .map((f) => `<i class="pill" style="--c:${flagDef(f.type).color}">${esc(flagDef(f.type).label)}</i>`)
              .join('');
          const rel = opts.relativeTo(p);
          return `<li><button type="button" data-sh="show" data-i="${i}">
            <strong>${esc(p.name || `Gst. ${p.gnr ?? ''}`)}</strong>
            <span>${esc(
              [p.gnr && p.name !== `Gst. ${p.gnr}` ? `Gst. ${p.gnr}` : '', p.kgName ? `KG ${p.kgName}` : '', formatArea(p.areaM2)]
                .filter(Boolean)
                .join(' · '),
            )}</span>
            ${flags ? `<span class="pills">${flags}</span>` : ''}
            ${rel ? `<em>${esc(rel)}</em>` : ''}
          </button></li>`;
        })
        .join('')}</ul>
      <div class="drawer-foot">
        <button type="button" data-sh="fit">Alle anzeigen</button>
      </div>
      <p class="fineprint">Grenzen zur Orientierung – nicht rechtsverbindlich.</p>`;
  }

  function close() {
    panel.hidden = true;
    list = undefined;
    opts.setShared([]);
    const url = new URL(location.href);
    url.searchParams.delete('share');
    history.replaceState(null, '', url);
  }

  panel.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-sh]');
    if (!el || !list) return;
    const act = el.dataset.sh;
    if (act === 'close') close();
    else if (act === 'fit') opts.fitAll(list.parcels);
    else if (act === 'show') {
      const p = list.parcels[Number(el.dataset.i)];
      if (p) opts.showParcel(p);
    }
  });

  async function open(token: string) {
    if (!accountsEnabled) return;
    try {
      list = (await getShare(token)) ?? undefined;
    } catch (e) {
      opts.toast(`Liste konnte nicht geladen werden: ${(e as Error).message}`);
      return;
    }
    if (!list) {
      opts.toast('Diese geteilte Liste gibt es nicht mehr oder sie ist abgelaufen.');
      return;
    }
    opts.setShared(list.parcels);
    opts.onOpen();
    panel.hidden = false;
    render();
    opts.fitAll(list.parcels);
  }

  const token = new URLSearchParams(location.search).get('share');
  return {
    openFromUrl: () => (token ? open(token) : undefined),
    open,
    isOpen: () => !panel.hidden && !!list,
    refreshDistances: () => render(),
    /** Step aside while a parcel card is shown … */
    suspend: () => {
      if (list) panel.hidden = true;
    },
    /** … and come back when it's closed. */
    resume: () => {
      if (list && panel.hidden) {
        panel.hidden = false;
        render();
      }
    },
  };
}

export type { LngLat };
