-- Forester: what grows on a field, and which land use a parcel has.
--   land_use: ['forest'] / ['field'] / both – detected from the BEV land-use
--             areas when the parcel is saved; decides whether a crop can be set
--   crop:     { "type": "koernermais", "year": 2026, "note": "…" } or null
alter table public.parcels add column land_use text[] not null default '{}';
alter table public.parcels add column crop jsonb;
alter table public.parcels add constraint parcels_crop_shape
  check (crop is null or (jsonb_typeof(crop) = 'object' and crop ? 'type' and crop ? 'year'));
