-- Forester: parcel groups, and sending parcels/groups to other app users.
--
-- Groups: each user sorts their parcels into named groups (one group per
--   parcel, like folders). Group ids are created in the app (uuid), so groups
--   also work without an account and can be uploaded later.
-- Direct sends: a share with a recipient. The recipient sees it under
--   "Erhalten" and gets a push; it opens like any shared list (get_share).

-- ---------- Groups ----------
create table public.parcel_groups (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  name text not null check (length(trim(name)) between 1 and 80),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, id)
);

alter table public.parcel_groups enable row level security;
create policy "Own groups: read" on public.parcel_groups
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Own groups: insert" on public.parcel_groups
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Own groups: update" on public.parcel_groups
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Own groups: delete" on public.parcel_groups
  for delete to authenticated using (user_id = (select auth.uid()));

alter table public.parcels add column group_id uuid;
-- A parcel can only be in one of its owner's own groups; deleting a group
-- leaves its parcels without a group.
alter table public.parcels
  add constraint parcels_group_fk foreign key (user_id, group_id)
  references public.parcel_groups (user_id, id) on delete set null (group_id);

-- ---------- Sending to other users ----------
alter table public.shares add column recipient_id uuid references auth.users (id) on delete cascade;
alter table public.shares add column seen_at timestamptz;
create index shares_recipient on public.shares (recipient_id, created_at desc) where recipient_id is not null;

create policy "Recipients read shares sent to them" on public.shares
  for select to authenticated using (recipient_id = (select auth.uid()));
-- Recipients may remove items from their inbox
create policy "Recipients delete shares sent to them" on public.shares
  for delete to authenticated using (recipient_id = (select auth.uid()));

-- Other members to send to (name only; the app is invite-only)
create or replace function public.list_members()
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, coalesce(nullif(trim(p.display_name), ''), 'Ohne Namen')
  from public.profiles p
  where p.id <> (select auth.uid())
  order by 2;
$$;
revoke execute on function public.list_members() from public, anon;
grant execute on function public.list_members() to authenticated;

-- What others sent me, with the sender's name
create or replace function public.received_shares()
returns table (token text, title text, item_count integer, from_name text, created_at timestamptz, seen boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.token, s.title, jsonb_array_length(s.parcels), coalesce(p.display_name, 'Unbekannt'), s.created_at, s.seen_at is not null
  from public.shares s
  left join public.profiles p on p.id = s.owner_id
  where s.recipient_id = (select auth.uid()) and s.expires_at > now()
  order by s.created_at desc
  limit 100;
$$;
revoke execute on function public.received_shares() from public, anon;
grant execute on function public.received_shares() to authenticated;

create or replace function public.mark_share_seen(share_token text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.shares set seen_at = coalesce(seen_at, now())
  where token = share_token and recipient_id = (select auth.uid());
$$;
revoke execute on function public.mark_share_seen(text) from public, anon;
grant execute on function public.mark_share_seen(text) to authenticated;

-- Push to the recipient (same Edge Function as reports)
create or replace function private.notify_direct_share()
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
    body := jsonb_build_object('share_token', new.token),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-webhook-secret', secret),
    timeout_milliseconds := 5000
  );
  return new;
exception when others then
  raise warning 'notify_direct_share failed: %', sqlerrm;
  return new;
end;
$$;

create trigger shares_notify_recipient
  after insert on public.shares
  for each row when (new.recipient_id is not null)
  execute function private.notify_direct_share();
