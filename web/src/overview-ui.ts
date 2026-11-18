// "Übersicht": all my parcels with name and status, sorted into groups;
// open reports and things others sent me ("Erhalten") at the top.

import { accountsEnabled, deleteReceived, listReceived, markReceivedSeen, type Received } from './account';
import { actionSheet, askText, choose } from './dialog';
import { FLAGS, flagDef, sortFlags, type FlagType } from './flags';
import { formatArea } from './geo';
import { isOwned, store, type Group, type SavedParcel } from './store';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Filter = 'all' | FlagType | 'none';
const NO_GROUP = '__none__';
const FLAGGED_ONLY = '__flagged__';

export function initOverview(opts: {
  isLoggedIn: () => boolean;
  relativeTo: (p: SavedParcel) => string;
  distance: (p: SavedParcel) => number | undefined;
  pendingKeys: () => Set<string>;
  showOnMap: (p: SavedParcel) => void;
  showAllOnMap: (parcels: SavedParcel[]) => void;
  openShared: (token: string) => void;
  send: (parcels: SavedParcel[], title: string) => void;
  shareLink: (parcels: SavedParcel[], title: string) => void;
  onChange: () => void;
  toast: (msg: string) => void;
}) {
  const page = document.getElementById('page-overview') as HTMLElement;
  const body = document.getElementById('overview-body') as HTMLElement;
  const receivedBox = document.getElementById('received') as HTMLElement;
  const filterBox = document.getElementById('overview-filter') as HTMLElement;
  let filter: Filter = 'all';
  let received: Received[] = [];
  const collapsed = new Set<string>();

  // ----- Status of a parcel -----
  function statusHtml(p: SavedParcel, pending: Set<string>) {
    const flags = sortFlags(p.flags);
    const pills = flags.map((f) => `<i class="pill" style="--c:${flagDef(f.type).color}">${esc(flagDef(f.type).label)}</i>`);
    if (pending.has(p.key)) pills.push('<i class="pill pill-outline" style="--c:#c62828">Meldung offen</i>');
    if (!pills.length) pills.push('<i class="pill pill-ok">Keine Meldung</i>');
    return `<span class="pills">${pills.join('')}</span>`;
  }

  function matches(p: SavedParcel) {
    if (filter === 'all') return true;
    if (filter === 'none') return !p.flags?.length;
    return !!p.flags?.some((f) => f.type === filter);
  }

  function sortParcels(list: SavedParcel[]) {
    return [...list].sort((a, b) => {
      const da = opts.distance(a);
      const db = opts.distance(b);
      if (da !== undefined && db !== undefined) return da - db;
      return a.name.localeCompare(b.name, 'de');
    });
  }

  function itemHtml(p: SavedParcel, pending: Set<string>) {
    const sub = [p.gnr && p.name !== `Gst. ${p.gnr}` ? `Gst. ${p.gnr}` : '', p.kgName ? `KG ${p.kgName}` : '', formatArea(p.areaM2)]
      .filter(Boolean)
      .join(' · ');
    const rel = opts.relativeTo(p);
    return `<li class="ov-item">
      <button type="button" class="ov-main" data-show="${esc(p.key)}">
        <strong>${esc(p.name)}</strong>
        <span>${esc(sub)}</span>
        ${statusHtml(p, pending)}
      </button>
      ${rel ? `<em class="ov-dist">${esc(rel)}</em>` : ''}
      <button type="button" class="icon ov-more" data-item="${esc(p.key)}" aria-label="Aktionen für ${esc(p.name)}">⋯</button>
    </li>`;
  }

  function sectionHtml(id: string, title: string, parcels: SavedParcel[], pending: Set<string>, isGroup: boolean) {
    const shown = sortParcels(parcels.filter(matches));
    if (!isGroup && !shown.length) return '';
    const open = !collapsed.has(id);
    const count = filter === 'all' ? `${parcels.length}` : `${shown.length} / ${parcels.length}`;
    return `<section class="ov-group" data-group="${esc(id)}">
      <header>
        <button type="button" class="ov-toggle" data-toggle="${esc(id)}" aria-expanded="${open}">
          <span class="chev">${open ? '▾' : '▸'}</span> <strong>${esc(title)}</strong> <span class="ov-count">${count}</span>
        </button>
        ${isGroup || id === NO_GROUP ? `<button type="button" class="icon ov-more" data-groupmenu="${esc(id)}" aria-label="Aktionen für ${esc(title)}">⋯</button>` : ''}
      </header>
      ${
        open
          ? shown.length
            ? `<ul>${shown.map((p) => itemHtml(p, pending)).join('')}</ul>`
            : `<p class="ov-empty">${parcels.length ? 'Keine passenden Grundstücke.' : 'Noch leer – über ⋯ bei einem Grundstück „In Gruppe verschieben“.'}</p>`
          : ''
      }
    </section>`;
  }

  function render() {
    const all = store.all();
    const groups = store.groups();
    const pending = opts.pendingKeys();
    const counts = (t: Filter) => all.filter((p) => (t === 'none' ? !p.flags?.length : p.flags?.some((f) => f.type === t))).length;

    filterBox.innerHTML = all.length
      ? [
          `<button type="button" data-filter="all" class="${filter === 'all' ? 'on' : ''}">Alle ${all.length}</button>`,
          ...FLAGS.map(
            (f) =>
              `<button type="button" data-filter="${f.type}" class="${filter === f.type ? 'on' : ''}" style="--c:${f.color}">${esc(f.label)} ${counts(f.type)}</button>`,
          ),
          `<button type="button" data-filter="none" class="${filter === 'none' ? 'on' : ''}" style="--c:#2e7d32">Keine Meldung ${counts('none')}</button>`,
        ].join('')
      : '';

    const inGroup = (g: Group) => all.filter((p) => p.groupId === g.id);
    const ungroupedOwn = all.filter((p) => !store.group(p.groupId) && isOwned(p));
    const ungroupedFlagged = all.filter((p) => !store.group(p.groupId) && !isOwned(p));

    let html = groups.map((g) => sectionHtml(g.id, g.name, inGroup(g), pending, true)).join('');
    html += sectionHtml(NO_GROUP, groups.length ? 'Ohne Gruppe' : 'Meine Grundstücke', ungroupedOwn, pending, false);
    html += sectionHtml(FLAGGED_ONLY, 'Nur markiert (nicht meine)', ungroupedFlagged, pending, false);
    if (!all.length)
      html = `<p class="ov-empty big">Noch keine Grundstücke gespeichert.<br>
        Auf der Karte hineinzoomen, ein Grundstück antippen und „Als mein Grundstück speichern“ wählen.</p>`;

    body.innerHTML = `${html}
      <div class="drawer-foot">
        <button type="button" data-ov="new-group">+ Neue Gruppe</button>
        ${all.length ? '<button type="button" data-ov="map-all">Alle auf Karte</button>' : ''}
      </div>
      <h3 class="ov-h">Sicherung</h3>
      <div class="drawer-foot">
        <button type="button" data-ov="export">Sichern</button>
        <label class="button">Laden<input data-ov="import" type="file" accept="application/json,.json" hidden /></label>
      </div>
      <p class="fineprint">${
        opts.isLoggedIn()
          ? 'Im Konto gespeichert – auf allen Geräten verfügbar, auf denen du angemeldet bist.'
          : 'Gespeichert nur auf diesem Gerät. Mit „Sichern“ eine Datei als Backup herunterladen – oder unter „Mehr“ anmelden.'
      }</p>`;
    renderReceived();
  }

  function renderReceived() {
    receivedBox.innerHTML = received.length
      ? `<h3 class="ov-h received-h">Erhalten</h3>
        <ul class="received-list">${received
          .map(
            (r) => `<li class="${r.seen ? '' : 'unseen'}">
              <button type="button" class="ov-main" data-open="${esc(r.token)}">
                <strong>${esc(r.title)}</strong>
                <span>von ${esc(r.fromName)} · ${r.count} Grundstück${r.count === 1 ? '' : 'e'} · ${new Date(r.createdAt).toLocaleDateString('de-AT')}</span>
              </button>
              <button type="button" class="icon" data-dismiss="${esc(r.token)}" aria-label="Entfernen" title="Entfernen">✕</button>
            </li>`,
          )
          .join('')}</ul>`
      : '';
    opts.onChange();
  }

  async function refreshReceived() {
    if (!accountsEnabled || !opts.isLoggedIn()) {
      received = [];
      renderReceived();
      return;
    }
    try {
      received = await listReceived();
    } catch {
      return;
    }
    renderReceived();
  }

  // ----- Actions -----
  const parcelsOf = (groupId: string) =>
    groupId === NO_GROUP
      ? store.all().filter((p) => !store.group(p.groupId) && isOwned(p))
      : store.all().filter((p) => p.groupId === groupId);

  async function moveDialog(p: SavedParcel) {
    const groups = store.groups();
    const id = await choose(`„${p.name}“ verschieben nach …`, [
      ...groups.map((g) => ({ id: g.id, label: g.name, sub: g.id === p.groupId ? 'aktuelle Gruppe' : undefined })),
      { id: NO_GROUP, label: 'Ohne Gruppe' },
      { id: '__new__', label: '+ Neue Gruppe …' },
    ]);
    if (!id) return;
    if (id === '__new__') {
      const name = await askText('Neue Gruppe', '', { placeholder: 'z. B. Revier Nord', ok: 'Anlegen' });
      if (!name) return;
      const g = store.addGroup(name);
      collapsed.delete(g.id);
      store.moveToGroup(p.key, g.id);
      opts.toast(`In „${g.name}“ verschoben.`);
    } else {
      store.moveToGroup(p.key, id === NO_GROUP ? undefined : id);
      opts.toast(id === NO_GROUP ? 'Aus der Gruppe genommen.' : `In „${store.group(id)?.name}“ verschoben.`);
    }
  }

  async function itemMenu(p: SavedParcel) {
    const act = await actionSheet(p.name, [
      { id: 'map', label: 'Auf Karte zeigen' },
      { id: 'move', label: 'In Gruppe verschieben' },
      { id: 'send', label: 'An Mitglied senden' },
      { id: 'link', label: 'Als Link teilen' },
      { id: 'rename', label: 'Umbenennen' },
    ]);
    if (act === 'map') opts.showOnMap(p);
    else if (act === 'move') await moveDialog(p);
    else if (act === 'send') opts.send([p], p.name);
    else if (act === 'link') opts.shareLink([p], p.name);
    else if (act === 'rename') {
      const name = await askText('Umbenennen', p.name, { ok: 'Speichern' });
      if (name) store.rename(p.key, name);
    }
  }

  async function groupMenu(groupId: string) {
    const g = store.group(groupId);
    const title = g?.name ?? 'Meine Grundstücke';
    const parcels = sortParcels(parcelsOf(groupId).filter(matches));
    const act = await actionSheet(title, [
      { id: 'map', label: 'Alle auf Karte zeigen' },
      { id: 'send', label: 'Gruppe an Mitglied senden' },
      { id: 'link', label: 'Gruppe als Link teilen' },
      ...(g
        ? [
            { id: 'rename', label: 'Gruppe umbenennen' },
            { id: 'delete', label: 'Gruppe löschen', danger: true },
          ]
        : []),
    ]);
    if (act === 'map') parcels.length ? opts.showAllOnMap(parcels) : opts.toast('Die Gruppe ist leer.');
    else if (act === 'send') opts.send(parcels, title);
    else if (act === 'link') opts.shareLink(parcels, title);
    else if (act === 'rename' && g) {
      const name = await askText('Gruppe umbenennen', g.name, { ok: 'Speichern' });
      if (name) store.renameGroup(g.id, name);
    } else if (act === 'delete' && g) {
      const n = parcelsOf(g.id).length;
      if (confirm(`Gruppe „${g.name}“ löschen?${n ? ` Die ${n} Grundstück(e) darin bleiben erhalten (ohne Gruppe).` : ''}`))
        store.deleteGroup(g.id);
    }
  }

  page.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const el = t.closest<HTMLElement>('[data-show],[data-item],[data-groupmenu],[data-toggle],[data-filter],[data-ov],[data-open],[data-dismiss]');
    if (!el) return;
    const d = el.dataset;
    if (d.show) {
      const p = store.get(d.show);
      if (p) opts.showOnMap(p);
    } else if (d.item) {
      const p = store.get(d.item);
      if (p) await itemMenu(p);
    } else if (d.groupmenu) await groupMenu(d.groupmenu);
    else if (d.toggle) {
      if (collapsed.has(d.toggle)) collapsed.delete(d.toggle);
      else collapsed.add(d.toggle);
      render();
    } else if (d.filter) {
      filter = d.filter as Filter;
      render();
    } else if (d.open) {
      const r = received.find((x) => x.token === d.open);
      if (r && !r.seen) {
        r.seen = true;
        void markReceivedSeen(r.token);
        renderReceived();
      }
      opts.openShared(d.open);
    } else if (d.dismiss) {
      if (!confirm('Aus „Erhalten“ entfernen?')) return;
      try {
        await deleteReceived(d.dismiss);
        received = received.filter((x) => x.token !== d.dismiss);
        renderReceived();
      } catch (err) {
        opts.toast((err as Error).message);
      }
    } else if (d.ov === 'new-group') {
      const name = await askText('Neue Gruppe', '', { placeholder: 'z. B. Revier Nord', ok: 'Anlegen' });
      if (name) {
        store.addGroup(name);
        opts.toast(`Gruppe „${name}“ angelegt. Grundstücke über ⋯ → „In Gruppe verschieben“ hinzufügen.`);
      }
    } else if (d.ov === 'map-all') opts.showAllOnMap(store.all());
    else if (d.ov === 'export') {
      const blob = new Blob([store.exportJson()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `forester-grundstuecke-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  });

  page.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.ov !== 'import') return;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const n = store.importJson(await file.text());
      opts.toast(`${n} Grundstück(e) geladen.`);
    } catch (err) {
      opts.toast(`Datei konnte nicht geladen werden: ${(err as Error).message}`);
    }
  });

  return {
    render,
    refreshReceived,
    unseenReceived: () => received.filter((r) => !r.seen).length,
  };
}
