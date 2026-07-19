-- SECURITY: lock down the LIVE delivery tables.
-- ----------------------------------------------------------------------------
-- delivery_schedule, delivery_trips and delivery_resources were created with
-- `for all using (true) with check (true)` policies (db/migrations.sql:3209-3254,
-- db/session-catchup.sql:490-574). Because the public anon key ships in the
-- browser bundle, that meant ANYONE — not even signed in — could read every
-- customer's delivery schedule and rewrite delivery/odometer/parking records
-- directly, bypassing the app's permission checks. (The 2026-07 HR RLS lockdown
-- only locked the OLD, unused `drivers`/`deliveries` tables and missed these.)
--
-- Fix: require an AUTHENTICATED user for read and write. Every real caller —
-- the driver PWA, the delivery-schedule / dispatch / transport pages, adding a
-- lorry, the HR & incoming lookups — runs as a signed-in staff member, so this
-- closes the anonymous hole WITHOUT breaking any legitimate workflow. The
-- service-role API routes (driver deliver/odometer) bypass RLS and are
-- unaffected. This intentionally does NOT use `using (true)`.
--
-- Run in the Supabase SQL editor. Safe to re-run (drop policy if exists).
-- ============================================================================

alter table public.delivery_schedule  enable row level security;
alter table public.delivery_trips     enable row level security;
alter table public.delivery_resources enable row level security;

-- delivery_schedule -----------------------------------------------------------
drop policy if exists ds_read  on public.delivery_schedule;
drop policy if exists ds_write on public.delivery_schedule;
create policy ds_read  on public.delivery_schedule for select to authenticated using (auth.uid() is not null);
create policy ds_write on public.delivery_schedule for all    to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);

-- delivery_trips --------------------------------------------------------------
drop policy if exists dt_read  on public.delivery_trips;
drop policy if exists dt_write on public.delivery_trips;
create policy dt_read  on public.delivery_trips for select to authenticated using (auth.uid() is not null);
create policy dt_write on public.delivery_trips for all    to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);

-- delivery_resources ----------------------------------------------------------
drop policy if exists dr_read  on public.delivery_resources;
drop policy if exists dr_write on public.delivery_resources;
create policy dr_read  on public.delivery_resources for select to authenticated using (auth.uid() is not null);
create policy dr_write on public.delivery_resources for all    to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);

notify pgrst, 'reload schema';
