-- ETA Beacon database setup.
-- Paste all of this into Supabase → SQL Editor → New query → Run.

create table if not exists public.units (
  unit_id      text primary key,          -- e.g. "M14"
  hospital_id  text not null,             -- matches an id in config.js
  status       text not null default 'enroute',  -- 'enroute' or 'arrived'
  lat          double precision,
  lng          double precision,
  eta_seconds  integer,
  distance_m   integer,
  updated_at   timestamptz not null default now()
);

alter table public.units enable row level security;

-- MVP ONLY: anyone with the public key can read and write.
-- Fine for testing with fake unit names. Must be locked down (logins) before real use.
create policy "mvp read"   on public.units for select to anon using (true);
create policy "mvp insert" on public.units for insert to anon with check (true);
create policy "mvp update" on public.units for update to anon using (true) with check (true);
grant select, insert, update on public.units to anon;

-- Turn on live updates for this table
alter publication supabase_realtime add table public.units;
