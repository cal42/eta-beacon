-- ETA Beacon database setup (safe to re-run).
-- Paste all of this into Supabase → SQL Editor → New query → Run.
--
-- Security model:
--   * Nobody can read or write with just the public key.
--   * Every device signs in with its own account:
--       - one "rig" account per rig phone (tied to a unit, e.g. M10)
--       - one "ed" account per ED screen (tied to a hospital)
--       - one "provider" account per physician (tied to a hospital)
--   * ED and provider accounts can only read units headed to their own hospital.
--   * Only ED accounts can set a trauma code (set_trauma); only providers
--     can mark themselves as responding (ack_trauma).
--   * Rig accounts can't write to the database directly. They send their
--     GPS position to the "eta" Edge Function, which checks who they are,
--     gets a Google ETA, and saves it.

-- ---------- Hospitals (destinations) ----------
create table if not exists public.hospitals (
  id    text primary key,              -- short code, e.g. "HMC"
  name  text not null,
  lat   double precision not null,     -- ambulance entrance
  lng   double precision not null
);

insert into public.hospitals (id, name, lat, lng) values
  ('HMC', 'Harborview ED',         47.60463, -122.32421),
  ('SFH', 'Swedish First Hill ED', 47.60788, -122.32207)
on conflict (id) do update set name = excluded.name, lat = excluded.lat, lng = excluded.lng;

-- ---------- Accounts (who each login is) ----------
create table if not exists public.accounts (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null check (role in ('rig', 'ed')),
  unit_id      text unique,                              -- rig accounts
  hospital_id  text references public.hospitals (id),    -- ed accounts
  check (
    (role = 'rig' and unit_id is not null) or
    (role = 'ed'  and hospital_id is not null)
  )
);
alter table public.accounts add column if not exists display_name text;  -- e.g. "Dr. Lee" (providers)

-- Allow the "provider" role (replaces the original unnamed checks)
alter table public.accounts drop constraint if exists accounts_role_check;
alter table public.accounts drop constraint if exists accounts_check;
alter table public.accounts drop constraint if exists accounts_role_valid;
alter table public.accounts drop constraint if exists accounts_link_valid;
alter table public.accounts add constraint accounts_role_valid
  check (role in ('rig', 'ed', 'provider'));
alter table public.accounts add constraint accounts_link_valid check (
  (role = 'rig'      and unit_id is not null) or
  (role = 'ed'       and hospital_id is not null) or
  (role = 'provider' and hospital_id is not null)
);

-- ---------- Units (live position + ETA, one row per unit) ----------
create table if not exists public.units (
  unit_id      text primary key,          -- e.g. "M10"
  hospital_id  text not null,
  status       text not null default 'enroute',  -- 'enroute' or 'arrived'
  lat          double precision,
  lng          double precision,
  eta_seconds  integer,
  distance_m   integer,
  updated_at   timestamptz not null default now()
);
alter table public.units add column if not exists eta_source text;  -- 'google' or 'estimate'

-- Trauma activation set by the ED (cleared automatically when the unit starts a new transport)
alter table public.units add column if not exists trauma_level  text;         -- 'modified' or 'full'
alter table public.units add column if not exists trauma_id     uuid;         -- new id each activation
alter table public.units add column if not exists trauma_set_at timestamptz;
alter table public.units drop constraint if exists units_trauma_level_valid;
alter table public.units add constraint units_trauma_level_valid
  check (trauma_level is null or trauma_level in ('modified', 'full'));

-- ---------- Trauma responders (providers who tapped "I'm responding") ----------
create table if not exists public.trauma_acks (
  trauma_id     uuid not null,
  user_id       uuid not null references auth.users (id) on delete cascade,
  hospital_id   text not null,
  unit_id       text not null,
  display_name  text not null,
  acked_at      timestamptz not null default now(),
  primary key (trauma_id, user_id)
);

-- ---------- Lock everything down ----------
alter table public.hospitals enable row level security;
alter table public.accounts  enable row level security;
alter table public.units     enable row level security;
alter table public.trauma_acks enable row level security;

-- Remove the old MVP "anyone can read/write" rules
drop policy if exists "mvp read"   on public.units;
drop policy if exists "mvp insert" on public.units;
drop policy if exists "mvp update" on public.units;

revoke all on public.units, public.hospitals, public.accounts, public.trauma_acks from anon;
revoke insert, update, delete on public.units, public.hospitals, public.accounts, public.trauma_acks from authenticated;
grant select on public.units, public.hospitals, public.accounts, public.trauma_acks to authenticated;

-- Each login can see its own account row
drop policy if exists "read own account" on public.accounts;
create policy "read own account" on public.accounts
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Any registered account can see the hospital list
drop policy if exists "accounts read hospitals" on public.hospitals;
create policy "accounts read hospitals" on public.hospitals
  for select to authenticated
  using (exists (select 1 from public.accounts a where a.user_id = (select auth.uid())));

-- ED/provider accounts see units headed to their hospital; rig accounts see their own unit
drop policy if exists "read relevant units" on public.units;
create policy "read relevant units" on public.units
  for select to authenticated
  using (exists (
    select 1 from public.accounts a
    where a.user_id = (select auth.uid())
      and (
        (a.role in ('ed', 'provider') and a.hospital_id = units.hospital_id) or
        (a.role = 'rig'               and a.unit_id     = units.unit_id)
      )
  ));

-- ED/provider accounts see who is responding to traumas at their hospital
drop policy if exists "read hospital trauma acks" on public.trauma_acks;
create policy "read hospital trauma acks" on public.trauma_acks
  for select to authenticated
  using (exists (
    select 1 from public.accounts a
    where a.user_id = (select auth.uid())
      and a.role in ('ed', 'provider')
      and a.hospital_id = trauma_acks.hospital_id
  ));

-- ---------- Trauma actions ----------
-- ED sets (or clears, with p_level = null) a trauma code on a unit headed to its hospital.
-- Every activation (including an upgrade modified → full) gets a new trauma_id,
-- which re-alerts providers.
create or replace function public.set_trauma(p_unit_id text, p_level text)
returns void language plpgsql security definer set search_path = public as $$
declare v_hosp text;
begin
  if p_level is not null and p_level not in ('modified', 'full') then
    raise exception 'Invalid trauma level';
  end if;
  select hospital_id into v_hosp from accounts where user_id = auth.uid() and role = 'ed';
  if v_hosp is null then raise exception 'Only ED accounts can set trauma codes'; end if;

  update units set
    trauma_level  = p_level,
    trauma_id     = case when p_level is null then null else gen_random_uuid() end,
    trauma_set_at = case when p_level is null then null else now() end
  where unit_id = p_unit_id and hospital_id = v_hosp;
  if not found then raise exception 'That unit is not headed to your hospital'; end if;
end $$;

-- Provider marks themselves as responding to a specific activation.
create or replace function public.ack_trauma(p_trauma_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_acct accounts; v_unit units;
begin
  select * into v_acct from accounts where user_id = auth.uid() and role = 'provider';
  if not found then raise exception 'Only provider accounts can respond'; end if;
  select * into v_unit from units where trauma_id = p_trauma_id and hospital_id = v_acct.hospital_id;
  if not found then raise exception 'This trauma activation is no longer active'; end if;

  insert into trauma_acks (trauma_id, user_id, hospital_id, unit_id, display_name)
  values (p_trauma_id, auth.uid(), v_acct.hospital_id, v_unit.unit_id,
          coalesce(v_acct.display_name, 'Provider'))
  on conflict do nothing;
end $$;

revoke execute on function public.set_trauma(text, text) from public, anon;
revoke execute on function public.ack_trauma(uuid)       from public, anon;
grant  execute on function public.set_trauma(text, text) to authenticated;
grant  execute on function public.ack_trauma(uuid)       to authenticated;

-- ---------- Live updates ----------
do $$
begin
  alter publication supabase_realtime add table public.units;
exception when duplicate_object then null;  -- already added
end $$;
do $$
begin
  alter publication supabase_realtime add table public.trauma_acks;
exception when duplicate_object then null;
end $$;


-- =====================================================================
-- ADDING DEVICES (run separately, after creating the login):
--   1. Supabase → Authentication → Users → Add user → Create new user
--      e.g. m10@rigs.etabeacon / a long password, tick "Auto Confirm User"
--   2. Link it to a unit or hospital:
--
-- insert into public.accounts (user_id, role, unit_id)
--   select id, 'rig', 'M10' from auth.users where email = 'm10@rigs.etabeacon';
--
-- insert into public.accounts (user_id, role, hospital_id)
--   select id, 'ed', 'HMC' from auth.users where email = 'hmc@ed.etabeacon';
--
-- insert into public.accounts (user_id, role, hospital_id, display_name)
--   select id, 'provider', 'HMC', 'Dr. Lee' from auth.users where email = 'drlee@example.org';
--
-- Lost/stolen phone: Authentication → Users → delete that user (or reset its password).
-- =====================================================================
