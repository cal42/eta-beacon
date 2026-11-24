-- ETA Beacon database setup (safe to re-run).
-- Paste all of this into Supabase → SQL Editor → New query → Run.
--
-- Security model:
--   * Nobody can read or write with just the public key.
--   * Every device signs in with its own account:
--       - one "rig" account per rig phone (tied to a unit, e.g. M10)
--       - one "ed" account per ED screen (tied to a hospital)
--       - one "provider" account per physician (tied to a hospital)
--       - one "mso" account per Medical Services Officer (tied to an agency)
--   * ED and provider accounts can only read units headed to their own hospital.
--   * MSO accounts can read every unit of their own agency, citywide.
--   * Shadow-mode units (unit_config.shadow, set by the admin) are hidden from ED and
--     provider accounts entirely; their data is still recorded for the trial.
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
alter table public.accounts add column if not exists agency_id text references public.agencies (id);  -- rig + mso accounts
-- One-time: existing rig accounts (all Seattle Fire so far) → SFD
update public.accounts set agency_id = 'SFD' where role = 'rig' and agency_id is null;

-- Allow the "provider" role (replaces the original unnamed checks)
alter table public.accounts drop constraint if exists accounts_role_check;
alter table public.accounts drop constraint if exists accounts_check;
alter table public.accounts drop constraint if exists accounts_role_valid;
alter table public.accounts drop constraint if exists accounts_link_valid;
alter table public.accounts add constraint accounts_role_valid
  check (role in ('rig', 'ed', 'provider', 'mso'));
alter table public.accounts add constraint accounts_link_valid check (
  (role = 'rig'      and unit_id is not null) or
  (role = 'ed'       and hospital_id is not null) or
  (role = 'provider' and hospital_id is not null) or
  (role = 'mso'      and agency_id is not null)
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
alter table public.units add column if not exists agency_id           text;     -- for the MSO view
alter table public.units add column if not exists route_polyline      text;     -- Google road route to the hospital (encoded)

-- In service / available tracking (MSO view). The EMS app goes in service when it opens
-- and checks in every 2 minutes, including between transports.
--   units.status: 'available' = in service, no active transport
alter table public.units alter column hospital_id drop not null;   -- available units have no destination
alter table public.units add column if not exists in_service        boolean not null default false;
alter table public.units add column if not exists in_service_since  timestamptz;
alter table public.units add column if not exists last_seen_at      timestamptz;  -- last check-in of any kind
alter table public.units add column if not exists out_of_service_at timestamptz;

-- Service status (set by the unit or its MSO through set_unit_service)
--   'in_service' | 'out_of_service' | 'special_event' (until special_event_until, then back in service)
alter table public.units add column if not exists service_status      text;
alter table public.units add column if not exists special_event_until timestamptz;
alter table public.units add column if not exists service_changed_at  timestamptz;
alter table public.units add column if not exists service_changed_by  text;   -- unit id or MSO name
alter table public.units drop constraint if exists units_service_status_valid;
alter table public.units add constraint units_service_status_valid
  check (service_status is null or service_status in ('in_service', 'out_of_service', 'special_event'));
-- One-time: carry over the earlier in/out of service flag
update public.units set service_status = case when in_service then 'in_service' else 'out_of_service' end
  where service_status is null and (in_service or out_of_service_at is not null);
update public.units u set agency_id = a.agency_id
  from public.accounts a where a.role = 'rig' and a.unit_id = u.unit_id and u.agency_id is null;
-- units.status: 'enroute' → 'arrived' → 'departed' (left the hospital; hidden from the ED board) → 'available'

-- ---------- Trial settings (admin only: edit in Supabase → Table Editor → unit_config) ----------
-- shadow = true: the unit's EMS app runs and records everything, but the ED board and
-- Provider app can't see it (the crew gives radio ETAs as usual). A change takes effect
-- at the unit's next transport. e.g.:
--   insert into unit_config (unit_id, shadow) values ('M1', true)
--     on conflict (unit_id) do update set shadow = excluded.shadow, updated_at = now();
create table if not exists public.unit_config (
  unit_id     text primary key,
  shadow      boolean not null default false,
  notes       text,
  updated_at  timestamptz not null default now()
);
alter table public.units add column if not exists shadow boolean not null default false;

-- Movement during a transport (set by the rig phone, no Google call):
--   motion_state: 'moving' | 'stopped' | 'stopped_care' (stopped >10 s after leaving the
--   scene while running lights & sirens → possibly patient care)
alter table public.units add column if not exists transport_started_at timestamptz;  -- on-scene clock
alter table public.units add column if not exists motion_state        text;
alter table public.units add column if not exists motion_since        timestamptz;
-- Speed is never displayed or stored (it could be used to second-guess emergency driving).
-- The phone uses GPS speed only in memory to tell moving from stopped. Remove any stored speed:
alter table public.units       drop column if exists speed_mps cascade;
alter table if exists public.eta_samples drop column if exists speed_mps cascade;  -- (eta_accuracy is recreated below)
alter table public.units add column if not exists current_stop_id     bigint;
-- Arrival stages: arrived_at = "on the ramp" (geofence); doors_at = "through the doors"
-- (charge nurse taps the button when the medics wheel the patient into the ED)
alter table public.units add column if not exists doors_at            timestamptz;
-- The ED marked this unit as transporting to them (crew too busy to tap Start)
alter table public.units add column if not exists ed_request_hospital_id text;
alter table public.units add column if not exists ed_request_at          timestamptz;
alter table public.units add column if not exists ed_request_by          text;

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
alter table public.transports add column if not exists shadow         boolean;      -- trial arm: true = ED couldn't see it
alter table public.transports add column if not exists started_by     text;         -- 'crew' or 'ed' (ED marked it transporting)
alter table public.transports add column if not exists doors_at       timestamptz;  -- medics through the ED doors (ramp time = doors_at − arrived_at)

-- Every stop after leaving the scene (start/end, and whether it looked like patient care)
create table if not exists public.transport_stops (
  id            bigint generated always as identity primary key,
  transport_id  uuid not null references public.transports (id) on delete cascade,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  lat           double precision,
  lng           double precision,
  likely_care   boolean not null default false
);
create index if not exists transport_stops_transport on public.transport_stops (transport_id);

-- ---------- ED feedback ----------
-- kind 'eta_rating': one tap on an arrived unit ("ETA accurate? Yes / No" + reason)
-- kind 'issue': "Report an issue" from the ED board
create table if not exists public.ed_feedback (
  id            bigint generated always as identity primary key,
  hospital_id   text not null references public.hospitals (id),
  kind          text not null check (kind in ('eta_rating', 'issue')),
  transport_id  uuid,
  unit_id       text,
  accurate      boolean,
  reason        text,       -- e.g. 'early', 'late', 'wrong hospital', 'never showed'
  comment       text,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ---------- Radio ETAs logged by the ED (for the radio vs. ETA Beacon trial) ----------
create table if not exists public.radio_etas (
  id           bigint generated always as identity primary key,
  hospital_id  text not null references public.hospitals (id),
  unit_id      text not null,
  eta_minutes  integer not null check (eta_minutes between 0 and 180),
  reported_at  timestamptz not null default now(),   -- when the radio ETA was given (= when logged)
  logged_by    uuid references auth.users (id) on delete set null,
  note         text,
  deleted_at   timestamptz                           -- "Undo" (kept for the record)
);
create index if not exists radio_etas_unit_time on public.radio_etas (unit_id, reported_at);
create index if not exists transports_unit_started on public.transports (unit_id, started_at desc);

-- One row per ETA calculated (about once a minute during a transport). Raw values.
create table if not exists public.eta_samples (
  id              bigint generated always as identity primary key,
  transport_id    uuid not null references public.transports (id) on delete cascade,
  recorded_at     timestamptz not null default now(),
  lat             double precision,
  lng             double precision,
  gps_accuracy_m  real,
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
alter table public.eta_samples add column if not exists motion_state text;
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
alter table public.unit_config enable row level security;   -- admin only
alter table public.radio_etas  enable row level security;
alter table public.transport_stops enable row level security;  -- admin only
alter table public.ed_feedback enable row level security;
revoke all on public.transport_stops from anon, authenticated;
revoke all on public.ed_feedback from anon;
revoke insert, update, delete on public.ed_feedback from authenticated;
grant select on public.ed_feedback to authenticated;
revoke all on public.transports, public.eta_samples, public.agencies, public.unit_config from anon, authenticated;
revoke all on public.radio_etas from anon;
revoke insert, update, delete on public.radio_etas from authenticated;
grant select on public.radio_etas to authenticated;

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

-- ED/provider accounts see units headed to their hospital; rig accounts see their own unit;
-- MSO accounts see every unit of their agency
drop policy if exists "read relevant units" on public.units;
create policy "read relevant units" on public.units
  for select to authenticated
  using (exists (
    select 1 from public.accounts a
    where a.user_id = (select auth.uid())
      and (
        (a.role in ('ed', 'provider') and a.hospital_id = units.hospital_id and not units.shadow) or
        (a.role = 'rig'               and a.unit_id     = units.unit_id) or
        (a.role = 'mso'               and a.agency_id   = units.agency_id)
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

-- ED accounts see the radio ETAs logged at their hospital
drop policy if exists "ed reads own radio etas" on public.radio_etas;
create policy "ed reads own radio etas" on public.radio_etas
  for select to authenticated
  using (exists (
    select 1 from public.accounts a
    where a.user_id = (select auth.uid()) and a.role = 'ed' and a.hospital_id = radio_etas.hospital_id
  ));

-- ED accounts see their own hospital's feedback (so a unit isn't asked to be rated twice)
drop policy if exists "ed reads own feedback" on public.ed_feedback;
create policy "ed reads own feedback" on public.ed_feedback
  for select to authenticated
  using (exists (
    select 1 from public.accounts a
    where a.user_id = (select auth.uid()) and a.role = 'ed' and a.hospital_id = ed_feedback.hospital_id
  ));

create or replace function public.submit_ed_feedback(
  p_kind text, p_transport_id uuid default null, p_unit_id text default null,
  p_accurate boolean default null, p_reason text default null, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_hosp text;
begin
  select hospital_id into v_hosp from accounts where user_id = auth.uid() and role = 'ed';
  if v_hosp is null then raise exception 'Only ED accounts can send feedback'; end if;
  if p_kind not in ('eta_rating', 'issue') then raise exception 'Invalid feedback type'; end if;
  if p_kind = 'eta_rating' and (p_transport_id is null or p_accurate is null) then
    raise exception 'A rating needs a transport and yes/no';
  end if;
  if p_kind = 'issue' and coalesce(trim(p_comment), '') = '' then
    raise exception 'Please describe the issue';
  end if;
  insert into ed_feedback (hospital_id, kind, transport_id, unit_id, accurate, reason, comment, created_by)
  values (v_hosp, p_kind, p_transport_id, nullif(upper(trim(p_unit_id)), ''), p_accurate,
          nullif(trim(p_reason), ''), left(nullif(trim(p_comment), ''), 2000), auth.uid());
end $$;

-- ED marks a unit as transporting to them after a radio report (crew too busy to tap Start).
-- The unit appears on the board with the radio ETA; if its EMS app is open it starts the
-- transport automatically and takes over with live ETAs.
create or replace function public.ed_mark_transporting(p_unit_id text, p_eta_minutes integer default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_acct accounts; v_unit text := upper(trim(p_unit_id)); v_agency text; v_u units; v_shadow boolean;
begin
  select * into v_acct from accounts where user_id = auth.uid() and role = 'ed';
  if not found then raise exception 'Only ED accounts can do that'; end if;
  select agency_id into v_agency from accounts where role = 'rig' and unit_id = v_unit;
  if not found then raise exception 'Unknown unit %', v_unit; end if;
  if p_eta_minutes is not null and p_eta_minutes not between 0 and 180 then
    raise exception 'ETA must be 0 to 180 minutes';
  end if;

  select coalesce((select shadow from unit_config where unit_id = v_unit), false) into v_shadow;
  if v_shadow then
    return 'radio_only';   -- trial radio-only group: not shown to the ED
  end if;

  select * into v_u from units where unit_id = v_unit;
  if found and v_u.status = 'enroute' and v_u.hospital_id is distinct from v_acct.hospital_id
     and v_u.updated_at > now() - interval '1 hour' then
    raise exception '% is already transporting to another hospital', v_unit;
  end if;
  if found and v_u.status = 'enroute' and v_u.hospital_id = v_acct.hospital_id
     and v_u.transport_id is not null and v_u.updated_at > now() - interval '10 minutes' then
    return 'already';      -- already on this board with live ETAs
  end if;

  insert into units (unit_id, agency_id, hospital_id, status, phase, eta_seconds,
                     eta_google_seconds, eta_ls_seconds, eta_source, driving_mode, transport_id,
                     route_polyline, arrived_at, motion_state, motion_since, transport_started_at,
                     trauma_level, trauma_id, trauma_set_at, shadow, doors_at,
                     ed_request_hospital_id, ed_request_at, ed_request_by, updated_at)
  values (v_unit, v_agency, v_acct.hospital_id, 'enroute', 'transporting',
          case when p_eta_minutes is not null then p_eta_minutes * 60 end,
          null, null, 'radio', 'unknown', null, null, null, null, null, now(),
          null, null, null, false, null,
          v_acct.hospital_id, now(), 'ED', now())
  on conflict (unit_id) do update set
    hospital_id = excluded.hospital_id, status = 'enroute', phase = 'transporting',
    eta_seconds = excluded.eta_seconds, eta_google_seconds = null, eta_ls_seconds = null,
    eta_source = 'radio', driving_mode = 'unknown', transport_id = null, route_polyline = null,
    arrived_at = null, motion_state = null, motion_since = null, transport_started_at = now(),
    trauma_level = null, trauma_id = null, trauma_set_at = null, shadow = false, doors_at = null,
    ed_request_hospital_id = excluded.ed_request_hospital_id, ed_request_at = now(),
    ed_request_by = 'ED', updated_at = now();
  return 'marked';
end $$;

-- ED charge nurse: the medics have wheeled the patient through the ED doors
create or replace function public.ed_mark_through_doors(p_unit_id text)
returns void language plpgsql security definer set search_path = public as $$
declare v_hosp text; v_tid uuid;
begin
  select hospital_id into v_hosp from accounts where user_id = auth.uid() and role = 'ed';
  if v_hosp is null then raise exception 'Only ED accounts can do that'; end if;
  update units set doors_at = now()
  where unit_id = p_unit_id and hospital_id = v_hosp and status = 'arrived' and doors_at is null
  returning transport_id into v_tid;
  if not found then raise exception 'That unit is not waiting on the ramp'; end if;
  if v_tid is not null then
    update transports set doors_at = now() where id = v_tid and doors_at is null;
  end if;
end $$;
revoke execute on function public.ed_mark_through_doors(text) from public, anon;
grant  execute on function public.ed_mark_through_doors(text) to authenticated;

-- ED: a radio-only unit (no live GPS) arrived, or should be cleared from the board
create or replace function public.ed_update_unit(p_unit_id text, p_action text)
returns void language plpgsql security definer set search_path = public as $$
declare v_hosp text;
begin
  select hospital_id into v_hosp from accounts where user_id = auth.uid() and role = 'ed';
  if v_hosp is null then raise exception 'Only ED accounts can do that'; end if;
  if p_action = 'arrived' then
    update units set status = 'arrived', arrived_at = now(), doors_at = null, eta_seconds = 0, updated_at = now()
    where unit_id = p_unit_id and hospital_id = v_hosp and status = 'enroute' and transport_id is null;
  elsif p_action = 'clear' then
    update units set status = 'departed', updated_at = now(), ed_request_hospital_id = null
    where unit_id = p_unit_id and hospital_id = v_hosp and transport_id is null;
  else
    raise exception 'Invalid action';
  end if;
  if not found then raise exception 'Only units without live GPS can be updated from the ED'; end if;
end $$;

revoke execute on function public.submit_ed_feedback(text, uuid, text, boolean, text, text) from public, anon;
revoke execute on function public.ed_mark_transporting(text, integer) from public, anon;
revoke execute on function public.ed_update_unit(text, text)          from public, anon;
grant  execute on function public.submit_ed_feedback(text, uuid, text, boolean, text, text) to authenticated;
grant  execute on function public.ed_mark_transporting(text, integer) to authenticated;
grant  execute on function public.ed_update_unit(text, text)          to authenticated;

-- ED logs a radio ETA ("M1, 8 minutes"); the time is recorded as now
create or replace function public.log_radio_eta(p_unit_id text, p_eta_minutes integer, p_note text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_hosp text; v_unit text := upper(trim(p_unit_id)); v_id bigint;
begin
  select hospital_id into v_hosp from accounts where user_id = auth.uid() and role = 'ed';
  if v_hosp is null then raise exception 'Only ED accounts can log radio ETAs'; end if;
  if v_unit is null or length(v_unit) not between 1 and 12 then raise exception 'Enter a unit, e.g. M1'; end if;
  if p_eta_minutes is null or p_eta_minutes not between 0 and 180 then
    raise exception 'ETA must be 0 to 180 minutes';
  end if;
  insert into radio_etas (hospital_id, unit_id, eta_minutes, logged_by, note)
  values (v_hosp, v_unit, p_eta_minutes, auth.uid(), nullif(trim(p_note), ''))
  returning id into v_id;
  return v_id;
end $$;

-- Undo a radio ETA logged at this hospital in the last 30 minutes
create or replace function public.delete_radio_eta(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_hosp text;
begin
  select hospital_id into v_hosp from accounts where user_id = auth.uid() and role = 'ed';
  if v_hosp is null then raise exception 'Only ED accounts can do that'; end if;
  update radio_etas set deleted_at = now()
  where id = p_id and hospital_id = v_hosp and deleted_at is null
    and reported_at > now() - interval '30 minutes';
  if not found then raise exception 'Can only undo radio ETAs from the last 30 minutes'; end if;
end $$;

revoke execute on function public.log_radio_eta(text, integer, text) from public, anon;
revoke execute on function public.delete_radio_eta(bigint)          from public, anon;
grant  execute on function public.log_radio_eta(text, integer, text) to authenticated;
grant  execute on function public.delete_radio_eta(bigint)          to authenticated;

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

-- ---------- Unit service status ----------
-- A rig can change its own status; an MSO can change any rig in their agency
-- (even one that hasn't opened the app today).
create or replace function public.set_unit_service(p_unit_id text, p_status text, p_minutes integer default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_acct accounts; v_by text; v_until timestamptz;
begin
  if p_status not in ('in_service', 'out_of_service', 'special_event') then
    raise exception 'Invalid status';
  end if;
  select * into v_acct from accounts where user_id = auth.uid();
  if not found then raise exception 'Not signed in'; end if;

  if v_acct.role = 'rig' then
    if v_acct.unit_id is distinct from p_unit_id then raise exception 'A rig can only change its own status'; end if;
    v_by := p_unit_id;
  elsif v_acct.role = 'mso' then
    if not exists (select 1 from accounts
                   where role = 'rig' and unit_id = p_unit_id and agency_id = v_acct.agency_id) then
      raise exception 'That unit is not in your agency';
    end if;
    v_by := coalesce(v_acct.display_name, 'MSO');
  else
    raise exception 'Not allowed';
  end if;

  if p_status = 'special_event' then
    if p_minutes is null or p_minutes < 15 or p_minutes > 1440 or p_minutes % 15 <> 0 then
      raise exception 'Special event time must be 15 minutes to 24 hours, in 15-minute steps';
    end if;
    v_until := now() + make_interval(mins => p_minutes);
  end if;

  insert into units (unit_id, agency_id, status, service_status, service_changed_at, service_changed_by,
                     special_event_until, in_service_since, out_of_service_at, updated_at)
  values (p_unit_id,
          (select agency_id from accounts where role = 'rig' and unit_id = p_unit_id limit 1),
          'available', p_status, now(), v_by, v_until,
          case when p_status <> 'out_of_service' then now() end,
          case when p_status = 'out_of_service' then now() end,
          now())
  on conflict (unit_id) do update set
    service_status      = excluded.service_status,
    service_changed_at  = now(),
    service_changed_by  = v_by,
    special_event_until = v_until,
    in_service_since    = case when excluded.service_status <> 'out_of_service'
                                and coalesce(units.service_status, 'out_of_service') = 'out_of_service'
                               then now() else units.in_service_since end,
    out_of_service_at   = case when excluded.service_status = 'out_of_service'
                               then now() else units.out_of_service_at end;
end $$;

-- MSO: every rig unit in their agency (including ones not in service today)
create or replace function public.agency_units()
returns table (unit_id text) language sql stable security definer set search_path = public as $$
  select r.unit_id from accounts m
  join accounts r on r.role = 'rig' and r.agency_id = m.agency_id
  where m.user_id = auth.uid() and m.role = 'mso'
  order by r.unit_id
$$;

revoke execute on function public.set_unit_service(text, text, integer) from public, anon;
revoke execute on function public.agency_units()                        from public, anon;
grant  execute on function public.set_unit_service(text, text, integer) to authenticated;
grant  execute on function public.agency_units()                        to authenticated;

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
  t.shadow,
  s.recorded_at,
  t.arrived_at,
  s.driving_mode,
  s.progress_ratio,
  s.distance_m,
  round(s.distance_m / 1609.34, 2)                         as distance_mi,
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

-- ---------- Radio vs. ETA Beacon (one row per logged radio ETA) ----------
-- Matches each radio ETA to that unit's transport to that hospital, then compares, from the
-- moment of the radio call: the radio ETA, ETA Beacon's ETA at that moment (its latest
-- transporting sample, counted down to the call time), and the actual arrival.
-- error = actual − predicted, seconds. Positive = arrived LATER than predicted.
drop view if exists public.radio_eta_accuracy;
create view public.radio_eta_accuracy with (security_invoker = true) as
select x.*,
       x.actual_s - x.radio_eta_s   as radio_error_s,
       x.actual_s - x.beacon_eta_s  as beacon_error_s
from (
  select
    r.id                                                       as radio_eta_id,
    r.unit_id,
    r.hospital_id,
    r.reported_at,
    r.eta_minutes,
    r.note,
    t.id                                                       as transport_id,
    t.shadow,                                                  -- true = ED couldn't see ETA Beacon
    t.trauma_level,
    t.final_driving_mode,
    t.arrival_method,
    t.arrived_at,
    extract(epoch from (t.arrived_at - r.reported_at))::int    as actual_s,
    r.eta_minutes * 60                                         as radio_eta_s,
    greatest(0, b.eta_best_s - extract(epoch from (r.reported_at - b.recorded_at))::int) as beacon_eta_s,
    extract(epoch from (r.reported_at - b.recorded_at))::int   as beacon_sample_age_s
  from public.radio_etas r
  left join lateral (
    select * from public.transports t
    where t.unit_id = r.unit_id and t.hospital_id = r.hospital_id
      and t.started_at <= r.reported_at + interval '5 minutes'
      and (t.arrived_at is null or t.arrived_at >= r.reported_at)
    order by t.started_at desc limit 1
  ) t on true
  left join lateral (
    select * from public.eta_samples s
    where s.transport_id = t.id and s.recorded_at <= r.reported_at
      and coalesce(s.phase, 'transporting') = 'transporting'
    order by s.recorded_at desc limit 1
  ) b on true
  where r.deleted_at is null
) x;

revoke all on public.radio_eta_accuracy from anon, authenticated;

-- ---------- Trial results ----------
-- One row per completed transport, with its trial arm:
--   'beacon' = the ED could see ETA Beacon; 'radio_only' = shadow mode (radio ETAs only)
drop view if exists public.trial_summary;
drop view if exists public.trial_transports;
create view public.trial_transports with (security_invoker = true) as
select
  t.id                                                        as transport_id,
  t.unit_id,
  t.hospital_id,
  case when t.shadow then 'radio_only' else 'beacon' end      as arm,
  coalesce(t.started_by, 'crew')                              as started_by,
  t.started_at,
  t.trauma_level,
  t.final_driving_mode,
  t.arrival_method,
  round(extract(epoch from (t.left_scene_at - t.started_at)) / 60.0, 1)  as scene_min,
  round(extract(epoch from (t.arrived_at - t.left_scene_at)) / 60.0, 1)  as drive_min,
  round(extract(epoch from (t.doors_at - t.arrived_at)) / 60.0, 1)       as ramp_min,   -- on the ramp → through the doors
  -- ETA Beacon: first ETA after leaving the scene vs. actual
  extract(epoch from (t.arrived_at - fs.recorded_at))::int - fs.eta_best_s  as beacon_first_error_s,
  -- First radio ETA for this transport, and ETA Beacon's ETA at that same moment
  ra.eta_minutes                                              as radio_eta_min,
  ra.radio_error_s,
  ra.beacon_error_s                                           as beacon_at_radio_error_s,
  -- Stops after leaving the scene
  coalesce(st.stops, 0)                                       as stops,
  coalesce(st.care_stops, 0)                                  as care_stops,
  round(coalesce(st.stopped_s, 0) / 60.0, 1)                  as stopped_min,
  -- ED's one-tap rating
  fb.accurate                                                 as ed_rated_accurate,
  fb.reason                                                   as ed_rating_reason,
  -- Trauma: how long before arrival the first provider tapped "I'm responding"
  round(extract(epoch from (t.arrived_at - ack.first_ack)) / 60.0, 1)    as provider_lead_min
from public.transports t
left join lateral (
  select s.recorded_at, s.eta_best_s from public.eta_samples s
  where s.transport_id = t.id and s.phase = 'transporting' and s.eta_source = 'google'
  order by s.recorded_at limit 1
) fs on true
left join lateral (
  select * from public.radio_eta_accuracy r where r.transport_id = t.id order by r.reported_at limit 1
) ra on true
left join lateral (
  select count(*) stops, count(*) filter (where likely_care) care_stops,
         sum(extract(epoch from (coalesce(ended_at, t.arrived_at) - started_at))) stopped_s
  from public.transport_stops where transport_id = t.id
) st on true
left join lateral (
  select f.accurate, f.reason from public.ed_feedback f
  where f.transport_id = t.id and f.kind = 'eta_rating' order by f.created_at desc limit 1
) fb on true
left join lateral (
  select min(a.acked_at) first_ack from public.trauma_acks a
  where a.unit_id = t.unit_id and a.hospital_id = t.hospital_id
    and a.acked_at between t.started_at and t.arrived_at
) ack on true
where t.arrived_at is not null;

-- Side-by-side summary per trial arm (errors in minutes; "off" = more than 2 minutes wrong)
create view public.trial_summary with (security_invoker = true) as
select
  arm,
  count(*)                                                              as transports,
  round(avg(scene_min), 1)                                              as avg_scene_min,
  round(avg(drive_min), 1)                                              as avg_drive_min,
  round(avg(ramp_min), 1)                                               as avg_ramp_min,
  count(radio_error_s)                                                  as with_radio_eta,
  round(avg(abs(radio_error_s)) / 60.0, 1)                              as radio_avg_abs_error_min,
  round(100.0 * avg((abs(radio_error_s) > 120)::int))                   as radio_pct_off,
  round(avg(abs(beacon_at_radio_error_s)) / 60.0, 1)                    as beacon_avg_abs_error_min,
  round(100.0 * avg((abs(beacon_at_radio_error_s) > 120)::int))         as beacon_pct_off,
  round(avg(abs(beacon_first_error_s)) / 60.0, 1)                       as beacon_first_eta_avg_abs_error_min,
  round(avg(care_stops), 2)                                             as avg_care_stops,
  count(ed_rated_accurate)                                              as ed_ratings,
  round(100.0 * avg(ed_rated_accurate::int))                            as ed_pct_rated_accurate,
  round(avg(provider_lead_min), 1)                                      as avg_provider_lead_min
from public.trial_transports
group by arm;

revoke all on public.trial_transports, public.trial_summary from anon, authenticated;

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
-- insert into public.accounts (user_id, role, agency_id, display_name)
--   select id, 'mso', 'SFD', 'MSO' from auth.users where email = 'mso@sfd.etabeacon';
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
-- Trial results, side by side per arm:   select * from trial_summary;
-- Every transport in the trial:          select * from trial_transports order by started_at desc;
-- Time on the ramp before going through the doors, by hospital:
--   select hospital_id, count(ramp_min), round(avg(ramp_min), 1) avg_ramp_min from trial_transports group by 1;
-- ED issue reports:                       select * from ed_feedback where kind = 'issue' order by created_at desc;
--
-- Radio vs. ETA Beacon (completed transports): average and typical error, in minutes
-- select count(*) n,
--        round(avg(abs(radio_error_s))  / 60.0, 1) radio_avg_abs_min,
--        round(avg(abs(beacon_error_s)) / 60.0, 1) beacon_avg_abs_min,
--        round(100.0 * avg((abs(radio_error_s)  > 120)::int)) radio_pct_over_2min,
--        round(100.0 * avg((abs(beacon_error_s) > 120)::int)) beacon_pct_over_2min
-- from radio_eta_accuracy where arrived_at is not null and beacon_eta_s is not null;
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
