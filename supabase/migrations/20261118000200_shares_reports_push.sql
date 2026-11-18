-- Forester: shared parcel lists, flag reports to owners, Web Push.
--
-- Shares: an owner snapshots a list of parcels; anyone with the link's token
--   can read it (get_share), no account needed.
-- Flag reports: when a user flags a parcel that other users saved as their own,
--   those owners get a pending report. The flag only lands on the owner's
--   parcel once they accept it (resolve_flag_report).
-- Push: a new report calls the Edge Function `notify-flag-report` (pg_net),
--   which sends a Web Push to the owner's subscribed devices.

create extension if not exists pg_net with schema extensions;

-- ---------- Private settings (not exposed through the API) ----------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.app_settings (
  name text primary key,
  value text not null
);
insert into private.app_settings (name, value) values
  ('webhook_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  ('notify_url', 'https://mokpbcogmpnmantbudmc.supabase.co/functions/v1/notify-flag-report');

-- For the Edge Function (service role only): webhook secret and VAPID keys
create or replace function public.push_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(name, value), '{}'::jsonb)
  from private.app_settings
  where name in ('webhook_secret', 'vapid_public', 'vapid_private');
$$;
revoke execute on function public.push_settings() from public, anon, authenticated;
grant execute on function public.push_settings() to service_role;

create or replace function public.push_store_vapid(pub text, priv text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.app_settings (name, value) values ('vapid_public', pub), ('vapid_private', priv)
  on conflict (name) do nothing;
$$;
revoke execute on function public.push_store_vapid(text, text) from public, anon, authenticated;
grant execute on function public.push_store_vapid(text, text) to service_role;

-- ---------- Shared lists ----------
create table public.shares (
  token text primary key default replace(gen_random_uuid()::text, '-', ''),
  owner_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  title text not null,
  parcels jsonb not null,           -- [{ key, name, kgNr, kgName, gnr, flags, geometry, center, areaM2 }]
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);

alter table public.shares enable row level security;
create policy "Own shares: read" on public.shares
  for select to authenticated using (owner_id = (select auth.uid()));
create policy "Own shares: create" on public.shares
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "Own shares: delete" on public.shares
  for delete to authenticated using (owner_id = (select auth.uid()));

-- Anyone with the token can read one share (no account needed)
create or replace function public.get_share(share_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'title', s.title,
    'createdAt', s.created_at,
    'expiresAt', s.expires_at,
    'ownerName', coalesce(p.display_name, 'Unbekannt'),
    'parcels', s.parcels
  )
  from public.shares s
  left join public.profiles p on p.id = s.owner_id
  where s.token = share_token and s.expires_at > now();
$$;
revoke execute on function public.get_share(text) from public;
grant execute on function public.get_share(text) to anon, authenticated;

-- ---------- Push subscriptions ----------
create table public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
create policy "Own subscriptions: read" on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Own subscriptions: delete" on public.push_subscriptions
  for delete to authenticated using (user_id = (select auth.uid()));

-- Register this device for the signed-in user (takes over the endpoint if the
-- device was used with another account before)
create or replace function public.register_push(sub_endpoint text, sub_p256dh text, sub_auth text)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (sub_endpoint, (select auth.uid()), sub_p256dh, sub_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
$$;
revoke execute on function public.register_push(text, text, text) from public, anon;
grant execute on function public.register_push(text, text, text) to authenticated;

-- ---------- Flag reports ----------
create table public.flag_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  reporter_id uuid references auth.users (id) on delete set null,
  reporter_name text,
  parcel_key text not null,
  parcel_name text,
  flag_type text not null check (flag_type in ('kaefer', 'windwurf', 'durchforsten')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create unique index flag_reports_one_pending
  on public.flag_reports (owner_id, parcel_key, flag_type) where status = 'pending';
create index flag_reports_owner on public.flag_reports (owner_id, status);

alter table public.flag_reports enable row level security;
create policy "Owners read their reports" on public.flag_reports
  for select to authenticated using (owner_id = (select auth.uid()));

-- New flags on a parcel → pending reports for everyone else who owns it
create or replace function private.report_new_flags()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  added text[];
  reporter text;
begin
  select coalesce(array_agg(distinct f ->> 'type'), '{}')
    into added
    from jsonb_array_elements(new.flags) f
    where tg_op = 'INSERT'
       or not exists (
         select 1 from jsonb_array_elements(old.flags) o where o ->> 'type' = f ->> 'type'
       );
  if cardinality(added) = 0 then
    return new;
  end if;

  select display_name into reporter from public.profiles where id = new.user_id;

  insert into public.flag_reports (owner_id, reporter_id, reporter_name, parcel_key, parcel_name, flag_type)
  select o.user_id, new.user_id, reporter, new.key, o.name, t
  from public.parcels o
  cross join unnest(added) as t
  where o.key = new.key
    and o.owned
    and o.user_id <> new.user_id
    and not exists (select 1 from jsonb_array_elements(o.flags) f where f ->> 'type' = t)
  on conflict (owner_id, parcel_key, flag_type) where status = 'pending' do nothing;

  return new;
end;
$$;

create trigger parcels_report_new_flags
  after insert or update of flags on public.parcels
  for each row execute function private.report_new_flags();

-- Owner accepts or rejects a report
create or replace function public.resolve_flag_report(report_id uuid, accept boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.flag_reports;
begin
  select * into r from public.flag_reports
    where id = report_id and owner_id = (select auth.uid()) and status = 'pending'
    for update;
  if not found then
    raise exception 'Meldung nicht gefunden oder schon erledigt.';
  end if;

  update public.flag_reports
    set status = case when accept then 'accepted' else 'rejected' end, resolved_at = now()
    where id = r.id;

  if accept then
    update public.parcels
      set flags = flags || jsonb_build_array(jsonb_build_object(
            'type', r.flag_type,
            'since', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'reportedBy', r.reporter_name))
      where user_id = r.owner_id
        and key = r.parcel_key
        and not exists (select 1 from jsonb_array_elements(flags) f where f ->> 'type' = r.flag_type);
  end if;
end;
$$;
revoke execute on function public.resolve_flag_report(uuid, boolean) from public, anon;
grant execute on function public.resolve_flag_report(uuid, boolean) to authenticated;

-- New report → ask the Edge Function to send a push (async, never blocks the flag)
create or replace function private.notify_flag_report()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  url text := (select value from private.app_settings where name = 'notify_url');
  secret text := (select value from private.app_settings where name = 'webhook_secret');
begin
  perform net.http_post(
    url := url,
    body := jsonb_build_object('report_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  raise warning 'notify_flag_report failed: %', sqlerrm;
  return new;
end;
$$;

create trigger flag_reports_notify
  after insert on public.flag_reports
  for each row execute function private.notify_flag_report();
