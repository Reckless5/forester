import 'maplibre-gl/dist/maplibre-gl.css';
import './app.css';
import {
  AttributionControl,
  GeolocateControl,
  Map as MLMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type GeoJSONSource,
  type MapGeoJSONFeature,
} from 'maplibre-gl';
// Let Vite bundle MapLibre's worker; otherwise it 404s in production builds.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { AUSTRIA_BOUNDS, AUSTRIA_CENTER, PARCEL_MINZOOM } from './config';
import { bbox, bearingDeg, compass, distanceM, formatArea, formatDistance, pointInPolygons, type LngLat } from './geo';
import { FLAGS, flagDef, formatSince, sortFlags, type FlagType } from './flags';
import { createForestIndex } from './forest';
import { identifyParcel, type ParcelInfo } from './parcel';
import { settings } from './settings';
import { isOwned, store, type SavedParcel } from './store';
import { buildStyle, EMPTY_FC, forestOnlyPaint, L, PARCEL_LINE, PARCEL_NUMBER } from './style';

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sheet = $('sheet');
const drawer = $('drawer');
const list = $('mine-list');
const chipHere = $('chip-here');
const chipZoom = $('chip-zoom');
const btnLayer = $<HTMLButtonElement>('btn-layer');
const menu = $('menu');
const chipDebug = $('chip-debug');

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// ---------- Map ----------
setWorkerUrl(workerUrl);

const map = new MLMap({
  container: 'map',
  style: buildStyle(),
  center: AUSTRIA_CENTER,
  zoom: 7,
  maxZoom: 19,
  maxBounds: [
    [AUSTRIA_BOUNDS[0][0] - 2, AUSTRIA_BOUNDS[0][1] - 1.5],
    [AUSTRIA_BOUNDS[1][0] + 2, AUSTRIA_BOUNDS[1][1] + 1.5],
  ],
  attributionControl: false,
});

map.addControl(new AttributionControl({ compact: true }), 'bottom-left');
map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-left');
map.addControl(new NavigationControl({ visualizePitch: false }), 'top-right');

const geolocate = new GeolocateControl({
  positionOptions: { enableHighAccuracy: true, timeout: 15000 },
  trackUserLocation: true,
  showAccuracyCircle: true,
  fitBoundsOptions: { maxZoom: 16 },
});
map.addControl(geolocate, 'top-right');

let myPos: LngLat | undefined;
let gpsPos: LngLat | undefined;
let placingDebugPos = false;
let listFilter: FlagType | 'all' = 'all';
let selected: { info: ParcelInfo | SavedParcel; saved: boolean } | undefined;

// ---------- Helpers ----------
function setSource(id: 'selected' | 'mine', data: GeoJSON.FeatureCollection) {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}

function fitTo(polys: number[][][][], maxZoom = 17) {
  const [[x0, y0], [x1, y1]] = bbox(polys as never);
  map.fitBounds(
    [
      [x0, y0],
      [x1, y1],
    ],
    { padding: { top: 80, bottom: 260, left: 40, right: 40 }, maxZoom },
  );
}

/** "350 m NO" from the user to the parcel, or "hier" when standing on it. */
function relativeTo(p: { center: LngLat; geometry: { coordinates: number[][][][] } }): string {
  if (!myPos) return '';
  if (pointInPolygons(myPos, p.geometry.coordinates as never)) return 'hier';
  return `${formatDistance(distanceM(myPos, p.center))} ${compass(bearingDeg(myPos, p.center))}`;
}

function relativeSentence(p: Parameters<typeof relativeTo>[0]): string {
  const r = relativeTo(p);
  return r === 'hier' ? 'Du bist auf diesem Grundstück' : r ? `${r} von dir` : '';
}

function parcelTitle(p: { gnr?: string }) {
  return p.gnr ? `Gst. ${p.gnr}` : 'Grundstück';
}

function parcelSub(p: { kgName?: string; kgNr?: string }) {
  if (p.kgName && p.kgNr) return `KG ${p.kgName} (${p.kgNr})`;
  if (p.kgName) return `KG ${p.kgName}`;
  if (p.kgNr) return `KG ${p.kgNr}`;
  return '';
}

// ---------- Saved parcels on the map + list ----------
// Dot positions for 1, 2 or 3 flags, so they stay centred (see flag-dot layers)
const FLAG_SLOTS = [[], [1], [0, 2], [0, 1, 2]];

store.subscribe((parcels) => {
  $('mine-count').textContent = String(parcels.filter(isOwned).length);
  const features: GeoJSON.Feature[] = [];
  for (const p of parcels) {
    const owned = isOwned(p);
    const flags = sortFlags(p.flags);
    const color = flags.length ? flagDef(flags[0].type).color : '#1565c0';
    features.push({ type: 'Feature', properties: { key: p.key, name: p.name, kind: 'area', owned, color }, geometry: p.geometry });
    features.push({
      type: 'Feature',
      properties: { key: p.key, name: p.name, kind: 'point', owned },
      geometry: { type: 'Point', coordinates: p.center },
    });
    flags.forEach((f, i) =>
      features.push({
        type: 'Feature',
        properties: { key: p.key, kind: 'flag', slot: FLAG_SLOTS[flags.length][i], color: flagDef(f.type).color },
        geometry: { type: 'Point', coordinates: p.center },
      }),
    );
  }
  if (map.isStyleLoaded()) setSource('mine', { type: 'FeatureCollection', features });
  else map.once('load', () => setSource('mine', { type: 'FeatureCollection', features }));
  renderList();
  updateHere();
});

function flagPills(p: SavedParcel) {
  const flags = sortFlags(p.flags);
  return flags.length
    ? `<span class="pills">${flags
        .map((f) => `<i class="pill" style="--c:${flagDef(f.type).color}">${esc(flagDef(f.type).label)}</i>`)
        .join('')}</span>`
    : '';
}

function listItem(p: SavedParcel) {
  return `
      <li><button type="button" data-key="${esc(p.key)}">
        <strong>${esc(p.name)}</strong>
        <span>${esc([isOwned(p) ? parcelTitle(p) : '', parcelSub(p), formatArea(p.areaM2)].filter(Boolean).join(' · '))}</span>
        ${flagPills(p)}
        ${myPos ? `<em>${esc(relativeTo(p))}</em>` : ''}
      </button></li>`;
}

function renderList() {
  const all = store.all();
  const parcels = all.filter((p) => listFilter === 'all' || p.flags?.some((f) => f.type === listFilter));
  if (myPos) parcels.sort((a, b) => distanceM(myPos!, a.center) - distanceM(myPos!, b.center));
  else parcels.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const own = parcels.filter(isOwned);
  const others = parcels.filter((p) => !isOwned(p));
  const count = (t: FlagType) => all.filter((p) => p.flags?.some((f) => f.type === t)).length;

  $('list-filter').innerHTML = [
    `<button type="button" data-filter="all" class="${listFilter === 'all' ? 'on' : ''}">Alle</button>`,
    ...FLAGS.map(
      (f) =>
        `<button type="button" data-filter="${f.type}" class="${listFilter === f.type ? 'on' : ''}" style="--c:${f.color}">${esc(f.label)} ${count(f.type)}</button>`,
    ),
  ].join('');

  let html = own.map(listItem).join('');
  if (others.length) html += `<li class="group">Nur markiert</li>` + others.map(listItem).join('');
  if (!parcels.length)
    html =
      listFilter === 'all'
        ? `<li class="empty">Noch keine Grundstücke gespeichert.<br>Hineinzoomen, auf ein Grundstück tippen und „Als mein Grundstück speichern“ wählen.</li>`
        : `<li class="empty">Keine Grundstücke mit „${esc(flagDef(listFilter).label)}“.</li>`;
  list.innerHTML = html;
}

$('list-filter').addEventListener('click', (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]')?.dataset.filter;
  if (!f) return;
  listFilter = f as FlagType | 'all';
  renderList();
});

list.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]');
  const p = btn && store.get(btn.dataset.key!);
  if (!p) return;
  drawer.hidden = true;
  showSaved(p);
  fitTo(p.geometry.coordinates);
});

// ---------- "You are on …" ----------
function updateHere() {
  const here = myPos && store.all().find((p) => pointInPolygons(myPos!, p.geometry.coordinates));
  chipHere.hidden = !here;
  if (here) chipHere.textContent = `Du bist auf: ${here.name}`;
}

// ---------- Selection sheet ----------
function select(info: ParcelInfo | SavedParcel, saved: boolean) {
  selected = { info, saved };
  setSource('selected', {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: info.geometry }],
  });
  renderSheet();
}

function showSaved(p: SavedParcel) {
  select(p, true);
}

function clearSelection() {
  selected = undefined;
  sheet.hidden = true;
  setSource('selected', EMPTY_FC);
}

function renderSheet() {
  if (!selected) return;
  const { info, saved } = selected;
  const kept = saved ? (info as SavedParcel) : store.get(info.key);
  const savedP = kept && isOwned(kept) ? kept : undefined;
  const flags = kept?.flags ?? [];
  const live = !saved ? (info as ParcelInfo) : undefined;
  const status =
    live?.rstatus === 'G' ? 'Grenzkataster (verbindlich)' : live?.rstatus === 'E' ? 'Grundsteuerkataster' : '';
  const meta = [parcelSub(info), formatArea(info.areaM2), status].filter(Boolean).join(' · ');
  const rel = relativeSentence(info);
  const [lng, lat] = info.center;

  sheet.innerHTML = `
    <div class="sheet-head">
      <div>
        <h2>${esc(savedP ? savedP.name : parcelTitle(info))}</h2>
        <p>${esc(savedP ? [parcelTitle(info), meta].join(' · ') : meta)}</p>
        ${rel ? `<p class="rel">${esc(rel)}</p>` : ''}
      </div>
      <button type="button" class="icon" data-act="close" aria-label="Schließen">✕</button>
    </div>
    ${
      live && !live.complete
        ? `<p class="warn">Das Grundstück ist größer als der geladene Kartenausschnitt. Zum vollständigen Speichern etwas herauszoomen und nochmal tippen.</p>`
        : ''
    }
    <div class="flag-buttons">
      ${FLAGS.map((d) => {
        const f = flags.find((x) => x.type === d.type);
        return `<button type="button" data-flag="${d.type}" class="flag ${f ? 'on' : ''}" style="--c:${d.color}" aria-pressed="${!!f}">
          ${esc(d.label)}${f ? `<small>seit ${esc(formatSince(f.since))}</small>` : ''}</button>`;
      }).join('')}
    </div>
    <div class="sheet-actions">
      ${
        savedP
          ? `<button type="button" data-act="rename">Umbenennen</button>
             <button type="button" data-act="remove" class="danger">Entfernen</button>`
          : `<button type="button" data-act="save" class="primary">Als mein Grundstück speichern</button>`
      }
      <a class="button" href="https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}" target="_blank" rel="noopener">Route</a>
    </div>
    <p class="fineprint">Grenzen zur Orientierung – nicht rechtsverbindlich.</p>
    ${
      live
        ? `<details><summary>Technische Details</summary><pre>${esc(
            JSON.stringify({ key: live.key, gstId: live.raw.gstId, gst: live.raw.gst, kg: live.raw.kg }, null, 2),
          )}</pre></details>`
        : ''
    }`;
  sheet.hidden = false;
}

sheet.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const flagType = target.closest<HTMLElement>('[data-flag]')?.dataset.flag as FlagType | undefined;
  if (flagType && selected) {
    const kept = store.toggleFlag(selected.info, flagType, parcelTitle(selected.info));
    if (kept) showSaved(kept);
    else renderSheet(); // dropped (no flags, not owned): keep showing the live parcel
    return;
  }
  const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!act || !selected) return;
  const { info } = selected;

  if (act === 'close') clearSelection();
  else if (act === 'save') {
    const name = prompt('Name für dieses Grundstück:', parcelTitle(info))?.trim();
    if (!name) return;
    showSaved(store.own(info, name));
  } else if (act === 'rename') {
    const cur = store.get(info.key);
    const name = prompt('Neuer Name:', cur?.name ?? '')?.trim();
    if (name) {
      store.rename(info.key, name);
      showSaved(store.get(info.key)!);
    }
  } else if (act === 'remove') {
    const cur = store.get(info.key);
    const hasFlags = !!cur?.flags?.length;
    const msg = `„${cur?.name}“ aus deinen Grundstücken entfernen?${hasFlags ? ' Die Markierungen bleiben erhalten.' : ''}`;
    if (cur && confirm(msg)) {
      store.disown(info.key);
      const still = store.get(info.key);
      if (still) showSaved(still);
      else clearSelection();
    }
  }
});

// ---------- Map interaction ----------
map.on('click', (e) => {
  if (placingDebugPos) {
    placingDebugPos = false;
    setDebugPos([e.lngLat.lng, e.lngLat.lat]);
    return;
  }
  const mine = map.queryRenderedFeatures(e.point, { layers: [...L.flagDots, L.mineDot, L.mineFill] })[0];
  if (mine) {
    const p = store.get(String(mine.properties?.key));
    if (p) {
      showSaved(p);
      if (map.getZoom() < 13) fitTo(p.geometry.coordinates);
      return;
    }
  }
  let hit = map.queryRenderedFeatures(e.point, { layers: [L.parcelHit] })[0] as MapGeoJSONFeature | undefined;
  if (hit && settings.get().forestOnly && !forest.isForest(hit.id)) hit = undefined;
  if (hit) {
    const info = identifyParcel(map, hit, e.lngLat);
    const saved = store.get(info.key);
    if (saved) showSaved(saved);
    else select(info, false);
  } else clearSelection();
});

for (const layer of [L.parcelHit, L.mineFill, L.mineDot, ...L.flagDots]) {
  map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
}

function updateZoomChip() {
  chipZoom.hidden = map.getZoom() >= PARCEL_MINZOOM;
}
map.on('zoomend', updateZoomChip);

// ---------- GPS ----------
function setMyPos(pos: LngLat | undefined) {
  myPos = pos;
  updateHere();
  if (!drawer.hidden) renderList();
  if (selected && !sheet.hidden) {
    const rel = sheet.querySelector('.rel');
    if (rel) rel.textContent = relativeSentence(selected.info);
  }
}

geolocate.on('geolocate', (e) => {
  gpsPos = [e.coords.longitude, e.coords.latitude];
  if (!settings.get().debugPos) setMyPos(gpsPos);
});

// ---------- Debug location (set your position by hand) ----------
const debugMarker = new Marker({ color: '#d81b60', draggable: true });
debugMarker.on('dragend', () => {
  const { lng, lat } = debugMarker.getLngLat();
  setDebugPos([lng, lat]);
});

function setDebugPos(pos: LngLat | undefined) {
  settings.set({ debugPos: pos });
  if (pos) {
    debugMarker.setLngLat(pos).addTo(map);
    setMyPos(pos);
  } else {
    debugMarker.remove();
    setMyPos(gpsPos);
  }
  chipDebug.hidden = !pos;
  chipDebug.textContent = 'Debug-Standort aktiv';
  renderMenu();
}

// ---------- Forest-only parcels ----------
const forest = createForestIndex(map);

function applyForestOnly() {
  const paint = forestOnlyPaint(settings.get().forestOnly);
  map.setPaintProperty(PARCEL_LINE, 'line-opacity', paint.parcelLine);
  map.setPaintProperty(PARCEL_NUMBER, 'text-opacity', paint.parcelNumber);
}

// ---------- Menu ----------
function renderMenu() {
  const s = settings.get();
  menu.innerHTML = `
    <div class="drawer-head">
      <h2>Einstellungen</h2>
      <button type="button" class="icon" data-menu="close" aria-label="Schließen">✕</button>
    </div>
    <label class="toggle">
      <input type="checkbox" data-menu="forestOnly" ${s.forestOnly ? 'checked' : ''} />
      <span>Nur Waldgrundstücke anzeigen</span>
    </label>
    <h3>Entwickler</h3>
    <p class="fineprint">Eigenen Standort von Hand setzen, z.&nbsp;B. um die App von zu Hause zu testen.
      Der Marker lässt sich verschieben.</p>
    <div class="sheet-actions">
      <button type="button" data-menu="placeDebug">${s.debugPos ? 'Standort neu setzen' : 'Standort auf Karte setzen'}</button>
      ${s.debugPos ? '<button type="button" data-menu="clearDebug">GPS verwenden</button>' : ''}
    </div>`;
}

menu.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-menu]')?.dataset.menu;
  if (act === 'close') menu.hidden = true;
  else if (act === 'placeDebug') {
    placingDebugPos = true;
    menu.hidden = true;
    clearSelection();
    chipDebug.hidden = false;
    chipDebug.textContent = 'Tippe auf die Karte, um deinen Standort zu setzen';
  } else if (act === 'clearDebug') setDebugPos(undefined);
});

menu.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.dataset.menu === 'forestOnly') {
    settings.set({ forestOnly: input.checked });
    applyForestOnly();
    clearSelection();
  }
});

$('btn-menu').addEventListener('click', () => {
  drawer.hidden = true;
  renderMenu();
  menu.hidden = !menu.hidden;
});

geolocate.on('error', () => {
  // No GPS: show saved parcels instead, if any
  const all = store.all();
  if (all.length) fitTo(all.flatMap((p) => p.geometry.coordinates), 15);
});

map.on('load', () => {
  updateZoomChip();
  applyForestOnly();
  const debugPos = settings.get().debugPos;
  if (debugPos) {
    setDebugPos(debugPos);
    map.jumpTo({ center: debugPos, zoom: 16 });
  } else geolocate.trigger(); // with a debug position, GPS would pull the map away
});

// ---------- Top bar ----------
btnLayer.addEventListener('click', () => {
  const orthoOn = map.getLayoutProperty(L.ortho, 'visibility') === 'visible';
  map.setLayoutProperty(L.ortho, 'visibility', orthoOn ? 'none' : 'visible');
  map.setLayoutProperty(L.basemap, 'visibility', orthoOn ? 'visible' : 'none');
  btnLayer.textContent = orthoOn ? 'Luftbild' : 'Karte';
});

$('btn-mine').addEventListener('click', () => {
  menu.hidden = true;
  drawer.hidden = !drawer.hidden;
  if (!drawer.hidden) renderList();
});
$('btn-drawer-close').addEventListener('click', () => (drawer.hidden = true));

$('btn-fit-all').addEventListener('click', () => {
  const all = store.all();
  if (!all.length) return;
  drawer.hidden = true;
  fitTo(all.flatMap((p) => p.geometry.coordinates), 16);
});

$('btn-export').addEventListener('click', () => {
  const blob = new Blob([store.exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `forester-grundstuecke-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$<HTMLInputElement>('input-import').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const n = store.importJson(await file.text());
    alert(`${n} Grundstück(e) geladen.`);
  } catch (err) {
    alert(`Datei konnte nicht geladen werden: ${(err as Error).message}`);
  }
});

// Handy for debugging in the browser console
Object.assign(window, { forester: { map, store } });
