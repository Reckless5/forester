# Data sources

All map data is open data from Austrian public bodies, licensed **CC BY 4.0**.
Attribution is shown in the map's attribution control and must stay visible.

## Cadastre (parcel boundaries) – BEV

The Bundesamt für Eich- und Vermessungswesen (BEV) publishes the digital cadastral
map (DKM) as vector tiles, updated daily. This is the same data that powers
[kataster.bev.gv.at](https://kataster.bev.gv.at).

- Tiles: `https://kataster.bev.gv.at/tiles/kataster/{z}/{x}/{y}.pbf` (EPSG:3857, 512 px, zoom 0–16)
- TileJSON: `https://kataster.bev.gv.at/styles/kataster/tiles.json`
- BEV's own styles (useful reference): `https://kataster.bev.gv.at/styles/kataster/style_{vermv|ortho|basic|gis}.json`
- Metadata / licence: [Datenkatalog BEV](https://data.bev.gv.at/geonetwork/srv/api/records/ea8097b2-fce6-4e01-bdba-2f319e09b1bd) – CC BY 4.0
- Geometry is accurate to the centimetre at zoom 16, but BEV notes that coordinates
  taken from the tiles are **not legally binding**.

### Layers in the tiles

Known from BEV's styles (field names in the tiles are not formally documented):

| Layer | Geometry | Known fields | Used for |
|---|---|---|---|
| `gst` | polygon | `rstatus` (`G` = Grenzkataster, `E` = Grundsteuerkataster) | Parcels |
| `gnr` | point | `gnr` (parcel number), `rstatus` | Parcel-number labels |
| `nfl` | polygon | `ns` (land-use code) | Forest areas |
| `kg` | polygon | `kg` (KG name) | Cadastral communities |
| `pg` | polygon | `pg` (municipality name) | – |
| `bl`, `blp` | polygon, point | `bl` (state name) | – |

Land-use codes (`ns`) we use: `56` Wälder, `55` Krummholzflächen, `58` Forststraßen
(map menu "Wälder anzeigen") and `48` Äcker, Wiesen oder Weiden ("Felder anzeigen").
Full list in the BEV GeoPackage spec, table 12.

If a parcel feature doesn't carry its own number, the app finds the `gnr` label
point inside the polygon instead. Tap a parcel and open **Technische Details** to
see exactly which fields the tiles contain.

### Bulk download (not used yet)

Twice a year (April and October) BEV publishes full snapshots ("Stichtagsdaten") as
GeoPackage (`KAT_DKM_GST_epsg31287_<YYYYMMDD>.gpkg`, tables `GST`, `NFL`,
`Grundstuecksverzeichnis`, …) on [data.bev.gv.at](https://data.bev.gv.at). We'd need these
for offline maps, search by parcel number, or server-side processing.
Spec: [BEV_S_KA_Katastralmappe_Grundstuecksdaten_GPKG](https://www.bev.gv.at/dam/jcr:239729f2-83e1-400e-9e5f-9ff65cc02257/BEV_S_KA_Katastralmappe_Grundstuecksdaten_GPKG_V1.0.pdf).

### KG index

`web/public/kg-index.json` lists all ~7,850 cadastral communities (number, name,
state, extent). It's generated from the `kg` layer of the zoom-10 tiles by
`web/scripts/build-kg-index.mjs`, run by the **Build KG index** GitHub Action
(manually, quarterly, or when the script changes).

## Place search – Photon (OpenStreetMap)

Villages, towns, peaks etc. are searched with [Photon](https://photon.komoot.io)
(komoot's public instance, OpenStreetMap data © OpenStreetMap contributors, ODbL).
It's free under fair use, so the app waits 350 ms after typing and needs 3+
characters. For heavy use we'd host our own instance.

## Base maps – basemap.at

- Map: `https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png`
- Aerial photo: `https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg`
- Note the `{y}/{x}` order. Licence: CC BY 4.0, see [basemap.at](https://basemap.at).

## Ownership

Owner data is **not** used. The land register (Grundbuch) is paid per query and
owner lists are restricted by data protection. Owners mark their own parcels in
the app instead.
