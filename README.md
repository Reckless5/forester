# forester

A map of Austria's forests and parcel boundaries, for forest owners.

- Shows parcel boundaries and forest areas from the official cadastre (BEV), updated daily
- GPS shows where you are, and you can pan around freely
- Mark your own parcels so you can find them again: name them, see how far away
  they are, and get a "Du bist auf: …" notice when you're standing on one

Boundaries are for orientation only and are not legally binding.

## Run it locally

Needs Node.js 20 or newer.

```bash
cd web
npm install
npm run dev
```

Open the URL Vite prints. To try GPS on your phone, open the **Network** URL on the
same Wi-Fi. Note that browsers only allow GPS over HTTPS, so on a phone it works on the
deployed site (below), not on the local network URL.

## Deploy

- **Netlify** (project `forester-at`, config in `netlify.toml`): every push to `dev` deploys to
  https://dev--forester-at.netlify.app
- **GitHub Pages** (optional): every push to `main` builds `web/` and publishes it
  (`.github/workflows/deploy.yml`). One-time setup: **Settings → Pages → Source: GitHub Actions**.

## Accounts (Supabase)

Project `forester` (eu-central-1). Schema in `supabase/migrations/`, applied in order.
Signups need an invite link (`?invite=<code>`); the first account became admin.
Admins create invite links in the app (☰ → Konto). Email confirmation is off.

For local development, copy `web/.env.example` to `web/.env.local` and fill in the
project URL and publishable key (Project Settings → API). Netlify has them set.

## Project layout

```
web/                 Web app (Vite + TypeScript + MapLibre GL)
  src/main.ts        Map setup, UI, GPS
  src/style.ts       Map layers (base map, forest, parcels, my parcels)
  src/parcel.ts      Works out which parcel was tapped
  src/store.ts       "Meine Grundstücke" (saved in the browser for now)
  src/geo.ts         Geometry helpers (area, distance, point-in-polygon)
  src/search.ts      Search: KG index, parcel lookup in BEV tiles, places via Photon
  scripts/build-kg-index.mjs  Builds public/kg-index.json (GitHub Action "Build KG index")
docs/
  data-sources.md    Where the data comes from, licences, tile layers
```

## Status / next steps

- [x] Map with BEV cadastre + basemap.at, forest areas highlighted
- [x] GPS location, tap a parcel, save it as "mine"
- [x] Saved parcels list with distance and direction, backup/restore as a file
- [x] Only forest parcels shown (toggle in ☰), debug location for testing
- [x] Flags on any parcel: Käferbefall, Windwurf, Durchforsten (with date), list filter
- [x] Search: own/flagged parcels, any parcel by KG + number, KGs, places (OpenStreetMap via Photon)
- [x] User accounts with invite links (Supabase), parcels sync across devices
- [ ] Offline use in the forest (PWA + cached tiles)

## Data & licences

Cadastre © BEV, base map © basemap.at – both CC BY 4.0. Details in
[docs/data-sources.md](docs/data-sources.md).
