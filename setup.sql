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
--   * ETA history (transports, eta_samples, eta_accuracy view) is readable by
--     NO app account — only by you in the Supabase dashboard / SQL Editor.

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

-- Automatic arrival / departure, in meters from the entrance. Change per hospital any time, e.g.:
--   update public.hospitals set arrival_radius_m = 75 where id = 'HMC';
--   arrival_radius_m:   rig phone records "arrived" when it comes within this distance
--   departure_radius_m: after arriving, the unit leaves the ED board once it drives beyond this
alter table public.hospitals add column if not exists arrival_radius_m integer not null default 50;
alter table public.hospitals alter column arrival_radius_m set default 50;
update public.hospitals set arrival_radius_m = 50 where arrival_radius_m = 10;  -- one-time: old 10 m default → 50 m
alter table public.hospitals add column if not exists departure_radius_m integer not null default 100;

-- ---------- Agencies (default ETA shown to the ED until driving mode is detected) ----------
-- default_driving_mode: 'ls' = lights & sirens, 'normal' = no lights & sirens
create table if not exists public.agencies (
  id                    text primary key,    -- e.g. 'SFD'
  name                  text not null,
  default_driving_mode  text not null default 'normal'
                        check (default_driving_mode in ('normal', 'ls'))
);
insert into public.agencies (id, name, default_driving_mode) values
  ('SFD', 'Seattle Fire Department', 'ls')
on conflict (id) do nothing;
-- Later, e.g.: insert into public.agencies values ('AMR', 'AMR', 'normal');

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
alter table public.accounts add column if not exists agency_id text references public.agencies (id);  -- rig accounts
-- One-time: existing rig accounts (all Seattle Fire so far) → SFD
update public.accounts set agency_id = 'SFD' where role = 'rig' and agency_id is null;

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

-- Driving mode + both ETAs (eta_seconds = the best estimate shown to the ED)
alter table public.units add column if not exists transport_id        uuid;
alter table public.units add column if not exists eta_google_seconds  integer;  -- no lights & sirens
alter table public.units add column if not exists eta_ls_seconds      integer;  -- lights & sirens
alter table public.units add column if not exists driving_mode        text;     -- 'unknown' | 'normal' | 'ls'
alter table public.units add column if not exists default_mode        text;     -- agency default until detected
alter table public.units add column if not exists phase               text;     -- 'onscene' | 'transporting'
alter table public.units add column if not exists arrived_at          timestamptz;
-- units.status: 'enroute' → 'arrived' → 'departed' (left the hospital; hidden from the ED board)

-- ---------- ETA history (for measuring accuracy) ----------
-- One row per transport (Start transport → arrival).
create table if not exists public.transports (
  id                  uuid primary key default gen_random_uuid(),
  unit_id             text not null,
  hospital_id         text not null references public.hospitals (id),
  status              text not null default 'enroute',   -- enroute | arrived | abandoned
  started_at          timestamptz not null default now(),
  start_lat           double precision,
  start_lng           double precision,
  first_eta_google_s  integer,
  first_distance_m    integer,
  trauma_level        text,
  arrived_at          timestamptz,
  arrival_method      text,              -- 'auto' (geofence) or 'button'
  arrival_lat         double precision,
  arrival_lng         double precision,
  arrival_distance_m  integer,           -- distance from the entrance when arrival was recorded
  arrival_radius_m    integer,           -- geofence radius in effect
  closest_approach_m  integer,           -- closest the phone got to the entrance (to tune the radius)
  final_driving_mode  text,
  ended_at            timestamptz
);
alter table public.transports add column if not exists agency_id      text;
alter table public.transports add column if not exists default_mode   text;         -- agency default in effect
alter table public.transports add column if not exists left_scene_at  timestamptz;  -- started driving (scene time = left_scene_at − started_at)
alter table public.transports add column if not exists departed_at    timestamptz;  -- drove away from the hospital
create index if not exists transports_unit_started on public.transports (unit_id, started_at desc);

-- One row per ETA calculated (about once a minute during a transport). Raw values.
create table if not exists public.eta_samples (
  id              bigint generated always as identity primary key,
  transport_id    uuid not null references public.transports (id) on delete cascade,
  recorded_at     timestamptz not null default now(),
  lat             double precision,
  lng             double precision,
  gps_accuracy_m  real,
  speed_mps       real,                 -- phone's GPS speed, when available
  distance_m      integer,              -- remaining route distance
  eta_google_s    integer,              -- raw Google ETA (no lights & sirens)
  eta_ls_s        integer,              -- eta_google_s × ls_factor
  eta_best_s      integer,              -- the one shown to the ED (based on driving_mode)
  ls_factor       real,                 -- lights & sirens factor in effect (0.75 = 25% faster)
  driving_mode    text,                 -- 'unknown' | 'normal' | 'ls'
  progress_ratio  real,                 -- how fast Google's ETA is falling vs the clock (≈1 normal, ≈1.33 L&S)
  eta_source      text                  -- 'google' or 'estimate'
);
alter table public.eta_samples add column if not exists phase text;  -- 'onscene' | 'transporting'
create index if not exists eta_samples_transport on public.eta_samples (transport_id, recorded_at);

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
alter table public.transports  enable row level security;   -- no policies: app accounts can't read
alter table public.eta_samples enable row level security;
alter table public.agencies    enable row level security;   -- read only by the Edge Function
revoke all on public.transports, public.eta_samples, public.agencies from anon, authenticated;

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

  -- record it on the transport history too
  update transports set trauma_level = p_level
  where id = (select transport_id from units where unit_id = p_unit_id);
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

-- ---------- ETA accuracy (one row per ETA sample while transporting, completed transports) ----------
-- error = actual − predicted, in seconds. Positive = arrived LATER than predicted.
-- actual_over_google = actual / Google ETA → the raw material for a correction factor.
-- On-scene samples are excluded (scene time isn't drive time).
drop view if exists public.eta_accuracy;
create view public.eta_accuracy with (security_invoker = true) as
select
  s.id                                                     as sample_id,
  t.id                                                     as transport_id,
  t.unit_id,
  t.hospital_id,
  t.trauma_level,
  t.arrival_method,
  t.final_driving_mode,
  t.agency_id,
  t.default_mode,
  s.recorded_at,
  t.arrived_at,
  s.driving_mode,
  s.progress_ratio,
  s.distance_m,
  round(s.distance_m / 1609.34, 2)                         as distance_mi,
  s.speed_mps,
  s.eta_source,
  s.ls_factor,
  extract(epoch from (t.arrived_at - s.recorded_at))::int  as actual_s,
  s.eta_google_s,
  s.eta_ls_s,
  s.eta_best_s,
  extract(epoch from (t.arrived_at - s.recorded_at))::int - s.eta_google_s as google_error_s,
  extract(epoch from (t.arrived_at - s.recorded_at))::int - s.eta_ls_s     as ls_error_s,
  extract(epoch from (t.arrived_at - s.recorded_at))::int - s.eta_best_s   as best_error_s,
  round(extract(epoch from (t.arrived_at - s.recorded_at))::numeric
        / nullif(s.eta_google_s, 0), 3)                    as actual_over_google,
  extract(hour from s.recorded_at at time zone 'America/Los_Angeles')::int   as local_hour,
  extract(isodow from s.recorded_at at time zone 'America/Los_Angeles')::int as local_weekday  -- 1 = Mon
from public.eta_samples s
join public.transports t on t.id = s.transport_id
where t.arrived_at is not null
  and s.recorded_at <= t.arrived_at
  and coalesce(s.phase, 'transporting') = 'transporting';

revoke all on public.eta_accuracy from anon, authenticated;

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
-- insert into public.accounts (user_id, role, unit_id, agency_id)
--   select id, 'rig', 'M10', 'SFD' from auth.users where email = 'm10@rigs.etabeacon';
--
-- insert into public.accounts (user_id, role, hospital_id)
--   select id, 'ed', 'HMC' from auth.users where email = 'hmc@ed.etabeacon';
--
-- insert into public.accounts (user_id, role, hospital_id, display_name)
--   select id, 'provider', 'HMC', 'Dr. Lee' from auth.users where email = 'drlee@example.org';
--
-- Lost/stolen phone: Authentication → Users → delete that user (or reset its password).
-- =====================================================================

-- =====================================================================
-- ANALYSIS EXAMPLES (run in SQL Editor; "Export" → CSV for Excel/Sheets)
--
-- Overall error by detected driving mode:
-- select driving_mode, count(*) samples,
--        round(avg(google_error_s)) avg_google_error_s,
--        round(avg(best_error_s))   avg_best_error_s,
--        round(avg(actual_over_google), 3) avg_actual_over_google
-- from eta_accuracy where eta_source = 'google' group by 1;
--
-- Measured lights & sirens factor (compare to the assumed 0.75):
-- select round(avg(actual_over_google), 3) from eta_accuracy
-- where final_driving_mode = 'ls' and eta_source = 'google';
--
-- Did the arrival geofence work? (button arrivals + how close they got)
-- select arrival_method, count(*), round(avg(closest_approach_m)) avg_closest_m
-- from transports where status = 'arrived' group by 1;
--
-- Scene time and time at hospital, per transport:
-- select unit_id, hospital_id, started_at,
--        left_scene_at - started_at  as scene_time,
--        arrived_at - left_scene_at  as drive_time,
--        departed_at - arrived_at    as time_at_hospital
-- from transports order by started_at desc;
-- =====================================================================
