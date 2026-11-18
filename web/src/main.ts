import 'maplibre-gl/dist/maplibre-gl.css';
import './app.css';
import {
  AttributionControl,
  GeolocateControl,
  Map as MLMap,
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
import { identifyParcel, type ParcelInfo } from './parcel';
import { store, type SavedParcel } from './store';
import { buildStyle, EMPTY_FC, L } from './style';

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sheet = $('sheet');
const drawer = $('drawer');
const list = $('mine-list');
const chipHere = $('chip-here');
const chipZoom = $('chip-zoom');
const btnLayer = $<HTMLButtonElement>('btn-layer');

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
store.subscribe((parcels) => {
  $('mine-count').textContent = String(parcels.length);
  const features: GeoJSON.Feature[] = [];
  for (const p of parcels) {
    features.push({ type: 'Feature', properties: { key: p.key, name: p.name, kind: 'area' }, geometry: p.geometry });
    features.push({
      type: 'Feature',
      properties: { key: p.key, name: p.name, kind: 'point' },
      geometry: { type: 'Point', coordinates: p.center },
    });
  }
  if (map.isStyleLoaded()) setSource('mine', { type: 'FeatureCollection', features });
  else map.once('load', () => setSource('mine', { type: 'FeatureCollection', features }));
  renderList();
  updateHere();
});

function renderList() {
  const parcels = [...store.all()];
  if (myPos) parcels.sort((a, b) => distanceM(myPos!, a.center) - distanceM(myPos!, b.center));
  else parcels.sort((a, b) => a.name.localeCompare(b.name, 'de'));

  list.innerHTML = parcels.length
    ? parcels
        .map(
          (p) => `
      <li><button type="button" data-key="${esc(p.key)}">
        <strong>${esc(p.name)}</strong>
        <span>${esc([parcelTitle(p), parcelSub(p), formatArea(p.areaM2)].filter(Boolean).join(' · '))}</span>
        ${myPos ? `<em>${esc(relativeTo(p))}</em>` : ''}
      </button></li>`,
        )
        .join('')
    : `<li class="empty">Noch keine Grundstücke gespeichert.<br>Hineinzoomen, auf ein Grundstück tippen und „Als mein Grundstück speichern“ wählen.</li>`;
}

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
  const savedP = saved ? (info as SavedParcel) : store.get(info.key);
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
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!act || !selected) return;
  const { info } = selected;

  if (act === 'close') clearSelection();
  else if (act === 'save') {
    const name = prompt('Name für dieses Grundstück:', parcelTitle(info))?.trim();
    if (!name) return;
    const p: SavedParcel = {
      key: info.key,
      name,
      kgName: info.kgName,
      kgNr: info.kgNr,
      gnr: info.gnr,
      geometry: info.geometry,
      center: info.center,
      areaM2: info.areaM2,
      savedAt: new Date().toISOString(),
    };
    store.save(p);
    showSaved(p);
  } else if (act === 'rename') {
    const cur = store.get(info.key);
    const name = prompt('Neuer Name:', cur?.name ?? '')?.trim();
    if (name) {
      store.rename(info.key, name);
      showSaved(store.get(info.key)!);
    }
  } else if (act === 'remove') {
    const cur = store.get(info.key);
    if (cur && confirm(`„${cur.name}“ aus deinen Grundstücken entfernen?`)) {
      store.remove(info.key);
      clearSelection();
    }
  }
});

// ---------- Map interaction ----------
map.on('click', (e) => {
  const mine = map.queryRenderedFeatures(e.point, { layers: [L.mineFill, L.mineDot] })[0];
  if (mine) {
    const p = store.get(String(mine.properties?.key));
    if (p) {
      showSaved(p);
      if (map.getZoom() < 13) fitTo(p.geometry.coordinates);
      return;
    }
  }
  const hit = map.queryRenderedFeatures(e.point, { layers: [L.parcelHit] })[0] as MapGeoJSONFeature | undefined;
  if (hit) {
    const info = identifyParcel(map, hit, e.lngLat);
    const saved = store.get(info.key);
    if (saved) showSaved(saved);
    else select(info, false);
  } else clearSelection();
});

for (const layer of [L.parcelHit, L.mineFill, L.mineDot]) {
  map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
}

function updateZoomChip() {
  chipZoom.hidden = map.getZoom() >= PARCEL_MINZOOM;
}
map.on('zoomend', updateZoomChip);

// ---------- GPS ----------
geolocate.on('geolocate', (e) => {
  myPos = [e.coords.longitude, e.coords.latitude];
  updateHere();
  if (!drawer.hidden) renderList();
  if (selected && !sheet.hidden) {
    const rel = sheet.querySelector('.rel');
    if (rel) rel.textContent = relativeSentence(selected.info);
  }
});

geolocate.on('error', () => {
  // No GPS: show saved parcels instead, if any
  const all = store.all();
  if (all.length) fitTo(all.flatMap((p) => p.geometry.coordinates), 15);
});

map.on('load', () => {
  updateZoomChip();
  geolocate.trigger();
});

// ---------- Top bar ----------
btnLayer.addEventListener('click', () => {
  const orthoOn = map.getLayoutProperty(L.ortho, 'visibility') === 'visible';
  map.setLayoutProperty(L.ortho, 'visibility', orthoOn ? 'none' : 'visible');
  map.setLayoutProperty(L.basemap, 'visibility', orthoOn ? 'visible' : 'none');
  btnLayer.textContent = orthoOn ? 'Luftbild' : 'Karte';
});

$('btn-mine').addEventListener('click', () => {
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
