-- Forester: user accounts with invite links, and parcels per user.
--
-- Signup rules (enforced in the database, so they also hold for direct API calls):
--   * The very first account needs no invite and becomes admin.
--   * Every other signup must send a valid, unused, unexpired invite code in
--     its user metadata (`invite_code`); the code is used up by that signup.
-- Email confirmation is switched off in the Auth settings.

-- ---------- Profiles ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Read own profile" on public.profiles
  for select to authenticated using (id = (select auth.uid()));

-- Users may change their name, but not make themselves admin
create policy "Update own profile" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
revoke update on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select is_admin from public.profiles where id = (select auth.uid())), false);
$$;

-- ---------- Invites ----------
create table public.invites (
  code text primary key default replace(gen_random_uuid()::text, '-', ''),
  note text,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  used_by uuid references auth.users (id) on delete set null,
  used_at timestamptz
);

alter table public.invites enable row level security;

create policy "Admins read invites" on public.invites
  for select to authenticated using ((select public.is_admin()));
create policy "Admins create invites" on public.invites
  for insert to authenticated with check ((select public.is_admin()) and created_by = (select auth.uid()));
create policy "Admins delete unused invites" on public.invites
  for delete to authenticated using ((select public.is_admin()) and used_at is null);

-- Lets the signup page check a code before submitting. Reveals nothing but valid/invalid.
create or replace function public.check_invite(invite_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.invites
    where code = invite_code and used_at is null and expires_at > now()
  );
$$;
revoke execute on function public.check_invite(text) from public;
grant execute on function public.check_invite(text) to anon, authenticated;

-- ---------- Signup gate on auth.users ----------
create or replace function public.gate_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- First account ever: allowed, becomes admin (see after_signup)
  if not exists (select 1 from auth.users) then
    return new;
  end if;
  if not exists (
    select 1 from public.invites
    where code = new.raw_user_meta_data ->> 'invite_code'
      and used_at is null
      and expires_at > now()
  ) then
    raise exception 'INVITE_INVALID: Ein gültiger Einladungslink ist nötig.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.after_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  first_user boolean := (select count(*) from auth.users) = 1;
begin
  if not first_user then
    -- Use up the invite; fails if someone else took it in the meantime
    update public.invites
      set used_by = new.id, used_at = now()
      where code = new.raw_user_meta_data ->> 'invite_code'
        and used_at is null
        and expires_at > now();
    if not found then
      raise exception 'INVITE_INVALID: Der Einladungslink wurde schon verwendet.'
        using errcode = 'check_violation';
    end if;
  end if;

  insert into public.profiles (id, display_name, is_admin)
  values (new.id, nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), first_user);
  return new;
end;
$$;

create trigger gate_signup
  before insert on auth.users
  for each row execute function public.gate_signup();

create trigger after_signup
  after insert on auth.users
  for each row execute function public.after_signup();

-- ---------- Parcels (own and flagged) ----------
create table public.parcels (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  key text not null,              -- "<KG-Nr>-<Gst-Nr>"
  name text not null,
  kg_nr text,
  kg_name text,
  gnr text,
  owned boolean not null default true,
  flags jsonb not null default '[]'::jsonb,   -- [{ "type": "kaefer", "since": "…" }]
  geometry jsonb not null,                    -- GeoJSON MultiPolygon (WGS84)
  center jsonb not null,                      -- [lng, lat]
  area_m2 double precision not null,
  saved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.parcels enable row level security;

create policy "Own parcels: read" on public.parcels
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Own parcels: insert" on public.parcels
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Own parcels: update" on public.parcels
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own parcels: delete" on public.parcels
  for delete to authenticated using (user_id = (select auth.uid()));

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger parcels_updated_at
  before update on public.parcels
  for each row execute function public.touch_updated_at();
