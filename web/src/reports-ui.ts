// "Meldungen": flags other users reported on my parcels, waiting for me to
// confirm or reject. Shown at the top of "Meine" and as a badge on its button.

import { listPendingReports, loadParcels, resolveReport, type FlagReport } from './account';
import { flagDef } from './flags';
import { onServiceWorkerMessage } from './push';
import { store } from './store';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function ago(iso: string) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  return new Date(iso).toLocaleDateString('de-AT');
}

export function initReports(opts: {
  isLoggedIn: () => boolean;
  showParcel: (key: string) => void;
  openList: () => void;
  toast: (msg: string) => void;
}) {
  const box = document.getElementById('reports') as HTMLElement;
  const badge = document.getElementById('reports-badge') as HTMLElement;
  let reports: FlagReport[] = [];
  let highlight: string | undefined = new URLSearchParams(location.search).get('report') ?? undefined;
  let busy = new Set<string>();

  function render() {
    badge.hidden = !reports.length;
    badge.textContent = String(reports.length);
    if (!reports.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = `<h3>Meldungen <span class="count">${reports.length}</span></h3>
      <p class="fineprint">Andere haben auf deinen Grundstücken etwas markiert. Erst wenn du bestätigst, wird die Markierung übernommen.</p>
      <ul class="report-list">${reports
        .map((r) => {
          const d = flagDef(r.flagType);
          const gnr = r.parcelKey.split('-').slice(1).join('-');
          const where = r.parcelName ? `${esc(r.parcelName)} (Gst. ${esc(gnr)})` : `Gst. ${esc(gnr)}`;
          return `<li class="${r.id === highlight ? 'highlight' : ''}" data-id="${r.id}">
            <div class="report-text">
              <i class="pill" style="--c:${d.color}">${esc(d.label)}</i>
              <span>${where}</span>
              <small>gemeldet von ${esc(r.reporterName ?? 'Unbekannt')} · ${ago(r.createdAt)}</small>
            </div>
            <div class="report-actions">
              <button type="button" data-rep="show">Zeigen</button>
              <button type="button" data-rep="reject" ${busy.has(r.id) ? 'disabled' : ''}>Ablehnen</button>
              <button type="button" data-rep="accept" class="primary" ${busy.has(r.id) ? 'disabled' : ''}>Bestätigen</button>
            </div>
          </li>`;
        })
        .join('')}</ul>`;
  }

  async function refresh() {
    if (!opts.isLoggedIn()) {
      reports = [];
      render();
      return;
    }
    try {
      reports = await listPendingReports();
    } catch {
      return; // offline etc. – keep what we have
    }
    render();
    if (highlight && reports.some((r) => r.id === highlight)) {
      opts.openList();
      const r = reports.find((x) => x.id === highlight)!;
      opts.showParcel(r.parcelKey);
    }
    // Only highlight once, and drop ?report= from the address
    if (highlight) {
      const url = new URL(location.href);
      url.searchParams.delete('report');
      history.replaceState(null, '', url);
    }
  }

  box.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-rep]');
    const li = btn?.closest<HTMLElement>('[data-id]');
    const r = li && reports.find((x) => x.id === li.dataset.id);
    if (!btn || !r) return;
    const act = btn.dataset.rep;
    if (act === 'show') {
      opts.showParcel(r.parcelKey);
      return;
    }
    busy.add(r.id);
    render();
    try {
      await resolveReport(r.id, act === 'accept');
      if (act === 'accept') store.reloaded(await loadParcels());
      opts.toast(act === 'accept' ? `${flagDef(r.flagType).label} übernommen.` : 'Meldung abgelehnt.');
      reports = reports.filter((x) => x.id !== r.id);
    } catch (err) {
      opts.toast((err as Error).message);
      await refresh();
    } finally {
      busy.delete(r.id);
      render();
    }
  });

  onServiceWorkerMessage((msg) => {
    if (msg.type === 'flag-report') void refresh();
    if (msg.type === 'open-url' && msg.url) {
      const id = new URL(msg.url).searchParams.get('report');
      if (id) {
        highlight = id;
        void refresh();
      }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });

  return { refresh };
}
