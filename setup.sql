-- ETA Beacon database setup (safe to re-run).
-- Paste all of this into Supabase → SQL Editor → New query → Run.
--
-- Security model:
--   * Nobody can read or write with just the public key.
--   * Every device signs in with its own account:
--       - one "rig" account per rig phone (tied to a unit, e.g. M10)
--       - one "ed" account per ED screen (tied to a hospital)
--   * ED accounts can only read units headed to their own hospital.
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

-- ---------- Lock everything down ----------
alter table public.hospitals enable row level security;
alter table public.accounts  enable row level security;
alter table public.units     enable row level security;

-- Remove the old MVP "anyone can read/write" rules
drop policy if exists "mvp read"   on public.units;
drop policy if exists "mvp insert" on public.units;
drop policy if exists "mvp update" on public.units;

revoke all on public.units, public.hospitals, public.accounts from anon;
revoke insert, update, delete on public.units, public.hospitals, public.accounts from authenticated;
grant select on public.units, public.hospitals, public.accounts to authenticated;

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

-- ED accounts see units headed to their hospital; rig accounts see their own unit
drop policy if exists "read relevant units" on public.units;
create policy "read relevant units" on public.units
  for select to authenticated
  using (exists (
    select 1 from public.accounts a
    where a.user_id = (select auth.uid())
      and (
        (a.role = 'ed'  and a.hospital_id = units.hospital_id) or
        (a.role = 'rig' and a.unit_id     = units.unit_id)
      )
  ));

-- ---------- Live updates ----------
do $$
begin
  alter publication supabase_realtime add table public.units;
exception when duplicate_object then null;  -- already added
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
-- Lost/stolen phone: Authentication → Users → delete that user (or reset its password).
-- =====================================================================
