// Search box in the top bar and its result list.

import { flagDef, sortFlags } from './flags';
import type { LngLat } from './geo';
import type { ParcelInfo } from './parcel';
import {
  findParcel,
  kgsAt,
  loadKgIndex,
  matchKgs,
  normalize,
  parseParcelQuery,
  searchPlaces,
  type BBox,
  type Kg,
  type Place,
} from './search';
import type { SavedParcel } from './store';

interface Deps {
  getCenter: () => LngLat;
  savedParcels: () => SavedParcel[];
  showSaved: (p: SavedParcel) => void;
  showParcel: (info: ParcelInfo) => void;
  fitBBox: (bbox: BBox, maxZoom: number) => void;
  flyTo: (center: LngLat, zoom: number) => void;
  onOpen: () => void;
}

type Item =
  | { type: 'saved'; p: SavedParcel }
  | { type: 'parcel'; kg: Kg; gnr: string }
  | { type: 'kg'; kg: Kg }
  | { type: 'place'; place: Place };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function initSearch(deps: Deps) {
  const form = document.getElementById('search-form') as HTMLFormElement;
  const input = document.getElementById('search-input') as HTMLInputElement;
  const clearBtn = document.getElementById('search-clear') as HTMLButtonElement;
  const panel = document.getElementById('search-results') as HTMLElement;

  let items: Item[] = [];
  let places: Place[] = [];
  let placesState: 'idle' | 'loading' | 'error' = 'idle';
  let placesError = '';
  let kgError = '';
  let hint = '';
  let busy = ''; // message while looking up a parcel
  let placesTimer: number | undefined;
  let placesAbort: AbortController | undefined;
  let parcelAbort: AbortController | undefined;
  let lastQuery = '';

  async function update() {
    const q = input.value.trim();
    clearBtn.hidden = !q;
    if (q === lastQuery && panel.hidden === false) return;
    lastQuery = q;
    if (!q) return close();

    // Local results right away
    const nq = normalize(q);
    const saved = deps
      .savedParcels()
      .filter((p) => normalize(`${p.name} ${p.gnr ?? ''} ${p.kgName ?? ''} ${p.kgNr ?? ''}`).includes(nq))
      .slice(0, 4)
      .map((p): Item => ({ type: 'saved', p }));

    let parcelItems: Item[] = [];
    let kgItems: Item[] = [];
    kgError = '';
    hint = '';
    try {
      const kgs = await loadKgIndex();
      if (q !== input.value.trim()) return; // typed on meanwhile
      // A bare 5-digit number is a KG number, not a parcel number
      const pq = /^\d{5}$/.test(q) && kgs.some((k) => k.nr === q) ? undefined : parseParcelQuery(q);
      if (pq) {
        const candidates = pq.kg
          ? /^\d{5}$/.test(pq.kg)
            ? kgs.filter((k) => k.nr === pq.kg)
            : matchKgs(kgs, pq.kg, 4)
          : kgsAt(kgs, deps.getCenter()).slice(0, 3);
        parcelItems = candidates.map((kg): Item => ({ type: 'parcel', kg, gnr: pq.gnr }));
        if (!candidates.length)
          hint = pq.kg
            ? `Keine KG „${pq.kg}“ gefunden.`
            : 'Für eine Grundstücksnummer bitte die KG dazuschreiben, z. B. „Rabnitz 1009/1“ oder „63269 1009/1“.';
      }
      if (!/^\.?\d+\/\d+$/.test(q)) kgItems = matchKgs(kgs, q, 5).map((kg): Item => ({ type: 'kg', kg }));
    } catch (e) {
      kgError = (e as Error).message;
    }
    items = [...saved, ...parcelItems, ...kgItems];
    render();

    // Places after a short pause, to go easy on the free service
    clearTimeout(placesTimer);
    placesAbort?.abort();
    places = [];
    placesState = 'idle';
    if (q.length >= 3 && !/^[\d./ -]+$/.test(q)) {
      placesState = 'loading';
      placesTimer = window.setTimeout(async () => {
        placesAbort = new AbortController();
        try {
          places = await searchPlaces(q, deps.getCenter(), placesAbort.signal);
          placesState = 'idle';
        } catch (e) {
          if ((e as Error).name === 'AbortError') return;
          placesState = 'error';
          placesError = (e as Error).message;
        }
        if (q === input.value.trim()) render();
      }, 350);
    }
    render();
  }

  function itemHtml(it: Item, i: number): string {
    const btn = (title: string, sub: string, extra = '') =>
      `<li><button type="button" data-i="${i}"><strong>${title}</strong><span>${sub}</span>${extra}</button></li>`;
    switch (it.type) {
      case 'saved': {
        const flags = sortFlags(it.p.flags)
          .map((f) => `<i class="pill" style="--c:${flagDef(f.type).color}">${esc(flagDef(f.type).label)}</i>`)
          .join('');
        return btn(
          esc(it.p.name),
          esc([it.p.gnr ? `Gst. ${it.p.gnr}` : '', it.p.kgName ? `KG ${it.p.kgName}` : ''].filter(Boolean).join(' · ')),
          flags ? `<span class="pills">${flags}</span>` : '',
        );
      }
      case 'parcel':
        return btn(`Gst. ${esc(it.gnr)}`, `KG ${esc(it.kg.name)} (${it.kg.nr}) · ${esc(it.kg.bl)}`);
      case 'kg':
        return btn(`KG ${esc(it.kg.name)}`, `Katastralgemeinde ${it.kg.nr} · ${esc(it.kg.bl)}`);
      case 'place':
        return btn(esc(it.place.name), esc([it.place.kind, it.place.context].filter(Boolean).join(' · ')));
    }
  }

  function render() {
    if (busy) {
      panel.innerHTML = `<p class="search-status">${esc(busy)}</p>`;
      panel.hidden = false;
      return;
    }
    const all: Item[] = [...items, ...places.map((place): Item => ({ type: 'place', place }))];
    const groups: [string, Item['type'][]][] = [
      ['Meine & markierte', ['saved']],
      ['Grundstücke', ['parcel']],
      ['Katastralgemeinden', ['kg']],
      ['Orte', ['place']],
    ];
    let html = '';
    for (const [title, types] of groups) {
      const rows = all.map((it, i) => [it, i] as const).filter(([it]) => types.includes(it.type));
      if (!rows.length) continue;
      html += `<h4>${title}</h4><ul>${rows.map(([it, i]) => itemHtml(it, i)).join('')}</ul>`;
    }
    if (placesState === 'loading') html += `<p class="search-status">Orte werden gesucht…</p>`;
    if (placesState === 'error') html += `<p class="search-status">${esc(placesError)}</p>`;
    if (kgError) html += `<p class="search-status">${esc(kgError)}</p>`;
    if (hint) html += `<p class="search-status">${esc(hint)}</p>`;
    if (!html) html = `<p class="search-status">Nichts gefunden.</p>`;
    html += `<p class="search-hint">Grundstück: KG-Name oder -Nummer und Grundstücksnummer, z.&nbsp;B. „Rabnitz 1009/1“.
      Orte: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> via Photon</p>`;
    panel.innerHTML = html;
    panel.dataset.items = String(all.length);
    (panel as HTMLElement & { _items?: Item[] })._items = all;
    panel.hidden = false;
    deps.onOpen();
  }

  function close() {
    panel.hidden = true;
    lastQuery = '';
    // Stop a pending place search, so it can't reopen the list later
    clearTimeout(placesTimer);
    placesAbort?.abort();
  }

  async function choose(it: Item) {
    switch (it.type) {
      case 'saved':
        close();
        input.blur();
        deps.showSaved(it.p);
        return;
      case 'kg':
        close();
        input.blur();
        deps.fitBBox(it.kg.bbox, 15);
        return;
      case 'place':
        close();
        input.blur();
        if (it.place.bbox) deps.fitBBox(it.place.bbox, it.place.zoom);
        else deps.flyTo(it.place.center, it.place.zoom);
        return;
      case 'parcel': {
        parcelAbort?.abort();
        parcelAbort = new AbortController();
        busy = `Suche Gst. ${it.gnr} in KG ${it.kg.name}…`;
        render();
        try {
          const info = await findParcel(it.kg, it.gnr, {
            signal: parcelAbort.signal,
            onProgress: (d, t) => {
              busy = `Suche Gst. ${it.gnr} in KG ${it.kg.name}… ${Math.round((d / t) * 100)} %`;
              render();
            },
          });
          busy = '';
          if (!info) {
            panel.innerHTML = `<p class="search-status">Gst. ${esc(it.gnr)} gibt es in KG ${esc(it.kg.name)} (${it.kg.nr}) nicht.</p>`;
            panel.hidden = false;
            lastQuery = '';
            return;
          }
          close();
          input.blur();
          deps.showParcel(info);
        } catch (e) {
          busy = '';
          if ((e as Error).name === 'AbortError') return;
          panel.innerHTML = `<p class="search-status">${esc((e as Error).message)}</p>`;
          panel.hidden = false;
          lastQuery = '';
        }
        return;
      }
    }
  }

  const currentItems = () => (panel as HTMLElement & { _items?: Item[] })._items ?? [];

  panel.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    if (!btn) return;
    const it = currentItems()[Number(btn.dataset.i)];
    if (it) void choose(it);
  });

  input.addEventListener('input', () => void update());
  input.addEventListener('focus', () => {
    void loadKgIndex().catch(() => {}); // warm up
    if (input.value.trim()) {
      lastQuery = '';
      void update();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
      input.blur();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const first = currentItems()[0];
    if (first) void choose(first);
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    parcelAbort?.abort();
    busy = '';
    close();
    clearBtn.hidden = true;
    input.focus();
  });

  return { close };
}
