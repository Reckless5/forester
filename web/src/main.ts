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
import { initOverview } from './overview-ui';
import { createLandUseIndex } from './landuse';
import { identifyParcel, type ParcelInfo } from './parcel';
import { settings } from './settings';
import { initAccount } from './account-ui';
import { claimPushForAccount, disablePush, enablePush, pushState, registerServiceWorker, type PushState } from './push';
import { initReports } from './reports-ui';
import { initSharedView, sendToMember, shareParcels } from './share-ui';
import { initSearch } from './search-ui';
import { isOwned, store, type SavedParcel } from './store';
import { buildStyle, EMPTY_FC, FIELD_COLOR, FOREST_COLOR, L, LANDUSE_LAYERS, PARCEL_LINE, PARCEL_NUMBER, parcelPaint } from './style';

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sheet = $('sheet');
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
const openingLink = /[?&](share|report)=/.test(location.search);
let loggedIn = false;
let sharedView: ReturnType<typeof initSharedView> | undefined;
let overview: ReturnType<typeof initOverview> | undefined;
let reports: ReturnType<typeof initReports> | undefined;
type Tab = 'map' | 'overview' | 'more';
let tab: Tab = 'map';
let selected: { info: ParcelInfo | SavedParcel; saved: boolean } | undefined;

// ---------- Helpers ----------
function setSource(id: 'selected' | 'mine' | 'shared', data: GeoJSON.FeatureCollection) {
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
  if (tab === 'overview') overview?.render();
  updateHere();
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
  sharedView?.resume();
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
  const shared = map.queryRenderedFeatures(e.point, { layers: [L.sharedDot, L.sharedFill] })[0];
  const sharedParcel = shared && sharedParcels.find((p) => p.key === shared.properties?.key);
  if (sharedParcel) {
    showSharedParcel(sharedParcel);
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
  // Only parcels of the kinds switched on in the map menu can be tapped
  const show = settings.get();
  if (hit && !((show.showForest && landUse.is('forest', hit.id)) || (show.showFields && landUse.is('field', hit.id))))
    hit = undefined;
  if (hit) {
    const info = identifyParcel(map, hit, e.lngLat);
    const saved = store.get(info.key);
    if (saved) showSaved(saved);
    else select(info, false);
  } else clearSelection();
});

for (const layer of [L.parcelHit, L.mineFill, L.mineDot, ...L.flagDots, L.sharedFill, L.sharedDot]) {
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
  if (tab === 'overview') overview?.render();
  if (sharedView?.isOpen()) sharedView.refreshDistances();
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

// ---------- Which parcels are shown (map menu) ----------
const landUse = createLandUseIndex(map);

function applyParcelVisibility() {
  const s = settings.get();
  const paint = parcelPaint({ forest: s.showForest, field: s.showFields });
  map.setPaintProperty(PARCEL_LINE, 'line-opacity', paint.parcelLine);
  map.setPaintProperty(PARCEL_NUMBER, 'text-opacity', paint.parcelNumber);
  for (const id of LANDUSE_LAYERS.forest) map.setLayoutProperty(id, 'visibility', s.showForest ? 'visible' : 'none');
  for (const id of LANDUSE_LAYERS.field) map.setLayoutProperty(id, 'visibility', s.showFields ? 'visible' : 'none');
}

// ---------- Map menu (layer button): base map + which parcels ----------
const mapMenu = $('map-menu');

function renderMapMenu() {
  const s = settings.get();
  const ortho = map.getLayoutProperty(L.ortho, 'visibility') === 'visible';
  mapMenu.innerHTML = `
    <h4>Kartenansicht</h4>
    <div class="segmented" role="group" aria-label="Kartenansicht">
      <button type="button" data-base="map" class="${ortho ? '' : 'on'}" aria-pressed="${!ortho}">Karte</button>
      <button type="button" data-base="ortho" class="${ortho ? 'on' : ''}" aria-pressed="${ortho}">Luftbild</button>
    </div>
    <h4>Grundstücke</h4>
    <label class="toggle"><input type="checkbox" data-mm="showForest" ${s.showForest ? 'checked' : ''} />
      <i class="swatch" style="--c:${FOREST_COLOR}"></i><span>Wälder anzeigen</span></label>
    <label class="toggle"><input type="checkbox" data-mm="showFields" ${s.showFields ? 'checked' : ''} />
      <i class="swatch" style="--c:${FIELD_COLOR}"></i><span>Felder anzeigen</span></label>
    <p class="fineprint">${
      s.showForest || s.showFields
        ? 'Grenzen und Nummern erscheinen beim Hineinzoomen.'
        : 'Keine Grundstücksgrenzen eingeblendet – deine gespeicherten Grundstücke bleiben sichtbar.'
    }</p>`;
}

function setMapMenu(open: boolean) {
  if (open) renderMapMenu();
  mapMenu.hidden = !open;
  btnLayer.classList.toggle('on', open);
  btnLayer.setAttribute('aria-expanded', String(open));
}

btnLayer.addEventListener('click', () => {
  search.close();
  setMapMenu(mapMenu.hidden);
});

mapMenu.addEventListener('click', (e) => {
  const base = (e.target as HTMLElement).closest<HTMLElement>('[data-base]')?.dataset.base;
  if (!base) return;
  map.setLayoutProperty(L.ortho, 'visibility', base === 'ortho' ? 'visible' : 'none');
  map.setLayoutProperty(L.basemap, 'visibility', base === 'ortho' ? 'none' : 'visible');
  renderMapMenu();
});

mapMenu.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const key = input.dataset.mm as 'showForest' | 'showFields' | undefined;
  if (!key) return;
  settings.set({ [key]: input.checked });
  applyParcelVisibility();
  clearSelection();
  renderMapMenu();
});

map.on('mousedown', () => setMapMenu(false));
map.on('touchstart', () => setMapMenu(false));

// ---------- Toast ----------
const toastEl = $('toast');
let toastTimer: number | undefined;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 4000);
}

// ---------- Account ----------
const account = initAccount({
  onOpen: () => setTab('more'),
  onChange: () => {
    loggedIn = !!account?.profile();
    clearSelection();
    overview?.render();
    renderMenu();
    void reports?.refresh();
    void overview?.refreshReceived();
    if (loggedIn) void claimPushForAccount();
  },
  beforeLogout: () => disablePush(),
  toast,
});

// ---------- Reports (others flagged my parcels) ----------
reports = initReports({
  isLoggedIn: () => loggedIn,
  showParcel: (key) => {
    const p = store.get(key);
    if (p) showOnMap(p);
  },
  openList: () => setTab('overview'),
  onChange: () => {
    updateBadge();
    if (tab === 'overview') overview?.render();
  },
  toast,
});

// ---------- Tabs ----------
function showOnMap(p: SavedParcel) {
  setTab('map');
  showSaved(p);
  fitTo(p.geometry.coordinates);
}

function setTab(next: Tab) {
  if (next === tab) return;
  tab = next;
  document.body.dataset.tab = next;
  $('page-overview').hidden = next !== 'overview';
  $('page-more').hidden = next !== 'more';
  document.querySelectorAll<HTMLButtonElement>('.tabbar [data-tab]').forEach((b) => {
    const on = b.dataset.tab === next;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  search.close();
  setMapMenu(false);
  if (next === 'overview') {
    overview?.render();
    void reports?.refresh();
    void overview?.refreshReceived();
  } else if (next === 'more') {
    void refreshPushStatus();
    renderMenu();
    account.open();
  } else {
    map.resize();
  }
}

function updateBadge() {
  const n = (reports?.count() ?? 0) + (overview?.unseenReceived() ?? 0);
  const badge = $('tab-badge');
  badge.hidden = !n;
  badge.textContent = String(n);
}

document.querySelector('.tabbar')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]');
  if (b) setTab(b.dataset.tab as Tab);
});

// ---------- Shared lists ----------
let sharedParcels: SavedParcel[] = [];
const SHARED_COLOR = '#00838f';

function showSharedParcel(p: SavedParcel) {
  sharedView?.suspend();
  // Show it like a tapped parcel, so it can be saved or flagged
  const kept = store.get(p.key);
  if (kept) showSaved(kept);
  else select({ ...p, complete: true, raw: { gst: {} } } as unknown as ParcelInfo, false);
  fitTo(p.geometry.coordinates);
}

sharedView = initSharedView({
  setShared: (parcels) => {
    sharedParcels = parcels;
    const features: GeoJSON.Feature[] = parcels.flatMap((p) => {
      const flags = sortFlags(p.flags);
      const color = flags.length ? flagDef(flags[0].type).color : SHARED_COLOR;
      return [
        { type: 'Feature', properties: { key: p.key, kind: 'area', color }, geometry: p.geometry },
        { type: 'Feature', properties: { key: p.key, kind: 'point', color }, geometry: { type: 'Point', coordinates: p.center } },
      ] as GeoJSON.Feature[];
    });
    const apply = () => setSource('shared', { type: 'FeatureCollection', features });
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  },
  fitAll: (parcels) => {
    if (parcels.length) fitTo(parcels.flatMap((p) => p.geometry.coordinates), 16);
  },
  showParcel: (p) => showSharedParcel(p),
  relativeTo: (p) => relativeTo(p),
  onOpen: () => setTab('map'),
  toast,
});

// ---------- Overview ----------
overview = initOverview({
  isLoggedIn: () => loggedIn,
  relativeTo: (p) => relativeTo(p),
  distance: (p) => (myPos ? distanceM(myPos, p.center) : undefined),
  pendingKeys: () => reports?.pendingKeys() ?? new Set(),
  showOnMap,
  showAllOnMap: (parcels) => {
    setTab('map');
    clearSelection();
    fitTo(parcels.flatMap((p) => p.geometry.coordinates), 16);
  },
  openShared: (token) => void sharedView?.open(token),
  send: (parcels, title) => void sendToMember(parcels, title, { isLoggedIn: loggedIn, toast }),
  shareLink: (parcels, title) => void shareParcels(parcels, title, { isLoggedIn: loggedIn, toast }),
  onChange: updateBadge,
  toast,
});

// ---------- Push notifications ----------
let pushStatus: PushState = 'unsupported';
const refreshPushStatus = async () => {
  pushStatus = await pushState();
  if (tab === 'more') renderMenu();
};

function pushMenuHtml() {
  if (!account.enabled || !loggedIn) return '';
  const hint: Record<PushState, string> = {
    on: 'Du bekommst eine Nachricht, wenn jemand auf deinen Grundstücken etwas meldet oder dir Grundstücke schickt.',
    off: 'Nachricht bekommen, wenn jemand auf deinen Grundstücken etwas meldet oder dir Grundstücke schickt.',
    denied: 'Benachrichtigungen sind für diese Seite im Browser blockiert. Bitte in den Browser-Einstellungen erlauben.',
    'needs-install':
      'Auf dem iPhone: zuerst über „Teilen → Zum Home-Bildschirm“ installieren und die App von dort öffnen.',
    unsupported: 'Dieser Browser unterstützt keine Benachrichtigungen.',
  };
  const canToggle = pushStatus === 'on' || pushStatus === 'off';
  return `<h3>Benachrichtigungen</h3>
    ${
      canToggle
        ? `<label class="toggle"><input type="checkbox" data-menu="push" ${pushStatus === 'on' ? 'checked' : ''} />
            <span>Benachrichtigungen</span></label>`
        : ''
    }
    <p class="fineprint">${hint[pushStatus]}</p>`;
}


// ---------- Menu ----------
function renderMenu() {
  const s = settings.get();
  menu.innerHTML = `
    <h2>Einstellungen</h2>
    ${pushMenuHtml()}
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
  if (act === 'placeDebug') {
    placingDebugPos = true;
    setTab('map');
    clearSelection();
    chipDebug.hidden = false;
    chipDebug.textContent = 'Tippe auf die Karte, um deinen Standort zu setzen';
  } else if (act === 'clearDebug') setDebugPos(undefined);
});

menu.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.dataset.menu === 'push') {
    input.disabled = true;
    (input.checked ? enablePush() : disablePush())
      .then(() => toast(input.checked ? 'Benachrichtigungen eingeschaltet.' : 'Benachrichtigungen ausgeschaltet.'))
      .catch((err: Error) => toast(err.message))
      .finally(refreshPushStatus);
    return;
  }

});


geolocate.on('error', () => {
  // No GPS: show saved parcels instead, if any
  const all = store.all();
  if (all.length) fitTo(all.flatMap((p) => p.geometry.coordinates), 15);
});

map.on('load', () => {
  updateZoomChip();
  applyParcelVisibility();
  const debugPos = settings.get().debugPos;
  if (debugPos) {
    setDebugPos(debugPos);
    map.jumpTo({ center: debugPos, zoom: 16 });
  } else if (!openingLink) geolocate.trigger(); // GPS would pull the map away from a debug position or link
  void sharedView?.openFromUrl();
});

registerServiceWorker();

// ---------- Top bar ----------


// ---------- Search ----------
const search = initSearch({
  getCenter: () => map.getCenter().toArray() as LngLat,
  savedParcels: () => store.all(),
  showSaved: (p) => {
    showSaved(p);
    fitTo(p.geometry.coordinates);
  },
  showParcel: (info) => {
    const saved = store.get(info.key);
    if (saved) showSaved(saved);
    else select(info, false);
    fitTo(info.geometry.coordinates);
  },
  fitBBox: ([w, s, e, n], maxZoom) =>
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 40, maxZoom },
    ),
  flyTo: (center, zoom) => map.flyTo({ center, zoom }),
  onOpen: () => {},
});
map.on('mousedown', () => search.close());
map.on('touchstart', () => search.close());


// Handy for debugging in the browser console
Object.assign(window, { forester: { map, store } });
