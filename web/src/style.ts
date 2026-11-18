import type { MapOptions } from 'maplibre-gl';
import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_TILES,
  FONT,
  GLYPHS,
  KATASTER_ATTRIBUTION,
  KATASTER_MAXZOOM,
  KATASTER_TILES,
  NS_DWARF_PINE,
  NS_FOREST,
  NS_FOREST_ROAD,
  ORTHO_TILES,
  PARCEL_MINZOOM,
} from './config';

type Style = Exclude<MapOptions['style'], string | undefined>;

export const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

/** Layer ids that the app code refers to. */
export const L = {
  basemap: 'basemap',
  ortho: 'ortho',
  parcelHit: 'parcel-hit',
  kgHit: 'kg-hit',
  selectedFill: 'selected-fill',
  selectedLine: 'selected-line',
  mineFill: 'mine-fill',
  mineLine: 'mine-line',
  mineLabel: 'mine-label',
  mineDot: 'mine-dot',
  flagDots: ['flag-dot-0', 'flag-dot-1', 'flag-dot-2'],
} as const;

const GREEN = '#2e7d32';
const MINE = '#1565c0';
const SELECTED = '#ef6c00';

/** Paint values for "only forest parcels" on/off. */
const onlyForest = (visible: number) =>
  ['case', ['boolean', ['feature-state', 'forest'], false], visible, 0] as unknown as number;

export function forestOnlyPaint(on: boolean) {
  return {
    parcelLine: on ? onlyForest(0.85) : 0.85,
    parcelNumber: on ? onlyForest(1) : 1,
  };
}

export const PARCEL_LINE = 'parcel-line';
export const PARCEL_NUMBER = 'parcel-number';

export function buildStyle(): Style {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      basemap: {
        type: 'raster',
        tiles: BASEMAP_TILES,
        tileSize: 256,
        maxzoom: 19,
        attribution: BASEMAP_ATTRIBUTION,
      },
      ortho: {
        type: 'raster',
        tiles: ORTHO_TILES,
        tileSize: 256,
        maxzoom: 19,
        attribution: BASEMAP_ATTRIBUTION,
      },
      kataster: {
        type: 'vector',
        tiles: [KATASTER_TILES],
        minzoom: 0,
        maxzoom: KATASTER_MAXZOOM,
        attribution: KATASTER_ATTRIBUTION,
      },
      selected: { type: 'geojson', data: EMPTY_FC },
      mine: { type: 'geojson', data: EMPTY_FC },
    },
    layers: [
      { id: L.basemap, type: 'raster', source: 'basemap' },
      { id: L.ortho, type: 'raster', source: 'ortho', layout: { visibility: 'none' } },

      // Forest land use
      {
        id: 'forest',
        type: 'fill',
        source: 'kataster',
        'source-layer': 'nfl',
        minzoom: 12,
        filter: ['in', ['get', 'ns'], ['literal', [NS_FOREST, NS_DWARF_PINE]]],
        paint: { 'fill-color': GREEN, 'fill-opacity': 0.28 },
      },
      {
        id: 'forest-road',
        type: 'fill',
        source: 'kataster',
        'source-layer': 'nfl',
        minzoom: 14,
        filter: ['==', ['get', 'ns'], NS_FOREST_ROAD],
        paint: { 'fill-color': '#8d6e63', 'fill-opacity': 0.5 },
      },

      // Cadastral community (KG) boundaries
      {
        id: L.kgHit,
        type: 'fill',
        source: 'kataster',
        'source-layer': 'kg',
        paint: { 'fill-color': '#000', 'fill-opacity': 0.001 },
      },
      {
        id: 'kg-line',
        type: 'line',
        source: 'kataster',
        'source-layer': 'kg',
        minzoom: 10,
        paint: { 'line-color': '#e65100', 'line-width': 1.2, 'line-opacity': 0.7 },
      },

      // Parcels. The invisible fill catches taps.
      {
        id: L.parcelHit,
        type: 'fill',
        source: 'kataster',
        'source-layer': 'gst',
        minzoom: PARCEL_MINZOOM,
        paint: { 'fill-color': '#000', 'fill-opacity': 0.001 },
      },
      {
        id: 'parcel-line',
        type: 'line',
        source: 'kataster',
        'source-layer': 'gst',
        minzoom: PARCEL_MINZOOM,
        paint: {
          'line-color': ['match', ['get', 'rstatus'], 'G', '#111', '#333'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.5, 18, 1.6],
          // Set by applyForestOnly(); feature-state `forest` comes from forest.ts
          'line-opacity': 0.85,
        },
      },

      // Kept parcels: own ones in blue, others (only flagged) in their first flag's colour.
      // Area features carry `owned` and `color` (set in main.ts).
      {
        id: L.mineFill,
        type: 'fill',
        source: 'mine',
        filter: ['==', ['get', 'kind'], 'area'],
        paint: {
          'fill-color': ['case', ['get', 'owned'], MINE, ['get', 'color']],
          'fill-opacity': ['case', ['get', 'owned'], 0.3, 0.18],
        },
      },
      {
        id: L.mineLine,
        type: 'line',
        source: 'mine',
        filter: ['==', ['get', 'kind'], 'area'],
        paint: {
          'line-color': ['case', ['get', 'owned'], MINE, ['get', 'color']],
          'line-width': ['case', ['get', 'owned'], 2.5, 2],
        },
      },
      {
        // Visible when zoomed out far enough that the area is tiny
        id: L.mineDot,
        type: 'circle',
        source: 'mine',
        maxzoom: 13,
        filter: ['all', ['==', ['get', 'kind'], 'point'], ['get', 'owned']],
        paint: {
          'circle-color': MINE,
          'circle-radius': 6,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
        },
      },

      // Flag dots below the parcel centre, one layer per position (circle-translate can't vary per feature)
      ...[0, 1, 2].map((slot) => ({
        id: `flag-dot-${slot}`,
        type: 'circle' as const,
        source: 'mine',
        filter: ['all', ['==', ['get', 'kind'], 'flag'], ['==', ['get', 'slot'], slot]] as never,
        paint: {
          'circle-color': ['get', 'color'] as never,
          'circle-radius': 7,
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 2,
          'circle-translate': [slot * 17 - 17, 16] as [number, number],
        },
      })),

      // Selected parcel
      {
        id: L.selectedFill,
        type: 'fill',
        source: 'selected',
        paint: { 'fill-color': SELECTED, 'fill-opacity': 0.25 },
      },
      {
        id: L.selectedLine,
        type: 'line',
        source: 'selected',
        paint: { 'line-color': SELECTED, 'line-width': 3 },
      },

      // Labels
      {
        id: 'kg-label',
        type: 'symbol',
        source: 'kataster',
        'source-layer': 'kg',
        minzoom: 11,
        maxzoom: 15,
        layout: { 'text-field': ['get', 'kg'], 'text-font': FONT, 'text-size': 13 },
        paint: { 'text-color': '#e65100', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
      },
      {
        id: 'parcel-number',
        type: 'symbol',
        source: 'kataster',
        'source-layer': 'gnr',
        minzoom: 16,
        layout: { 'text-field': ['get', 'gnr'], 'text-font': FONT, 'text-size': 11 },
        paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
      },
      {
        id: L.mineLabel,
        type: 'symbol',
        source: 'mine',
        minzoom: 13,
        filter: ['all', ['==', ['get', 'kind'], 'point'], ['get', 'owned']],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': FONT,
          'text-size': 14,
          'text-allow-overlap': true,
          'text-offset': [0, -0.4],
        },
        paint: { 'text-color': MINE, 'text-halo-color': '#fff', 'text-halo-width': 2 },
      },
    ],
  };
}
