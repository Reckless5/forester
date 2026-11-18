// External data sources. All are free to use with attribution (CC BY 4.0).
// See docs/data-sources.md for details.

/** BEV cadastre vector tiles, updated daily. Layers: nfl, gst, kg, pg, bl, blp, gnr. */
export const KATASTER_TILES = 'https://kataster.bev.gv.at/tiles/kataster/{z}/{x}/{y}.pbf';
export const KATASTER_MAXZOOM = 16;
export const KATASTER_ATTRIBUTION =
  '<a href="https://www.bev.gv.at" target="_blank" rel="noopener">© BEV</a> (CC BY 4.0)';

/** Fonts served by the BEV alongside their own map styles. */
export const GLYPHS = 'https://kataster.bev.gv.at/styles/fonts/{fontstack}/{range}.pbf';
export const FONT = ['Roboto Bold'];

/** basemap.at raster tiles (note the {y}/{x} order). */
export const BASEMAP_TILES = [
  'https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png',
];
export const ORTHO_TILES = [
  'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg',
];
export const BASEMAP_ATTRIBUTION =
  '<a href="https://basemap.at" target="_blank" rel="noopener">basemap.at</a> (CC BY 4.0)';

/** Land-use codes (NS) in the `nfl` layer that we treat as forest. */
export const NS_FOREST = 56; // Wälder
export const NS_DWARF_PINE = 55; // Krummholzflächen
export const NS_FOREST_ROAD = 58; // Forststraßen
export const NS_FIELD = 48; // Äcker, Wiesen oder Weiden

/** Parcels are only in the tiles from this zoom on. */
export const PARCEL_MINZOOM = 14;

export const AUSTRIA_CENTER: [number, number] = [13.33, 47.6];
export const AUSTRIA_BOUNDS: [[number, number], [number, number]] = [
  [9.3, 46.3],
  [17.3, 49.1],
];
