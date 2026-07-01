-- 2026-07 · EASWARI — HR attendance/OT + Driver delivery modules (step 1: schema)
-- ----------------------------------------------------------------------------
-- Standalone copy of the new-module tables for pasting into the Supabase SQL
-- Editor. Identical to the section at the bottom of db/migrations.sql.
-- Safe to re-run (everything uses "if not exists" / "drop policy if exists").
-- ============================================================================

-- Shift profiles — per-employee OT threshold + how lunch is handled.
create table if not exists public.shift_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normal_hours numeric not null default 7.5,          -- OT threshold, hours/day
  lunch_rule text not null default 'punch',           -- 'punch' | 'auto_deduct'
  lunch_minutes int not null default 60,              -- used when auto_deduct
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.shift_profiles to authenticated;
grant all on public.shift_profiles to service_role;
alter table public.shift_profiles enable row level security;
drop policy if exists sp_read on public.shift_profiles;
create policy sp_read on public.shift_profiles for select using (true);
drop policy if exists sp_write on public.shift_profiles;
create policy sp_write on public.shift_profiles for all using (true) with check (true);

-- Employees — one row per person, keyed by the ZKLink A0xx code.
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  employee_code text not null unique,                 -- ZKLink A0xx code
  shift_profile_id uuid references public.shift_profiles(id),
  is_driver boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.employees to authenticated;
grant all on public.employees to service_role;
alter table public.employees enable row level security;
drop policy if exists emp_read on public.employees;
create policy emp_read on public.employees for select using (true);
drop policy if exists emp_write on public.employees;
create policy emp_write on public.employees for all using (true) with check (true);

-- Attendance punches — raw clock events pulled from ZKLink.
-- source_id is the dedupe key: 'employee_code|punch_time'.
create table if not exists public.attendance_punches (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null,
  punch_time timestamptz not null,
  source_id text not null unique,                     -- dedupe: employee_code|punch_time
  first_name text,
  department_name text,
  raw jsonb,
  created_at timestamptz not null default now()
);
create index if not exists attendance_punches_emp_time_idx
  on public.attendance_punches (employee_code, punch_time);
grant select, insert, update, delete on public.attendance_punches to authenticated;
grant all on public.attendance_punches to service_role;
alter table public.attendance_punches enable row level security;
drop policy if exists ap_read on public.attendance_punches;
create policy ap_read on public.attendance_punches for select using (true);
drop policy if exists ap_write on public.attendance_punches;
create policy ap_write on public.attendance_punches for all using (true) with check (true);

-- Attendance reviews — a human's decision for one employee on one day.
create table if not exists public.attendance_reviews (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null,
  work_date date not null,                            -- KL calendar date
  lunch_decision text,                                -- 'deduct' | 'worked_through' | 'manual'
  manual_minutes int,                                 -- worked minutes when set manually
  note text,
  reviewed_by uuid,
  reviewed_by_name text,
  reviewed_at timestamptz not null default now(),
  unique (employee_code, work_date)
);
grant select, insert, update, delete on public.attendance_reviews to authenticated;
grant all on public.attendance_reviews to service_role;
alter table public.attendance_reviews enable row level security;
drop policy if exists ar_read on public.attendance_reviews;
create policy ar_read on public.attendance_reviews for select using (true);
drop policy if exists ar_write on public.attendance_reviews;
create policy ar_write on public.attendance_reviews for all using (true) with check (true);

-- Sync cursor — remembers how far ZKLink has been pulled.
create table if not exists public.sync_state (
  key text primary key,                               -- e.g. 'zklink'
  last_synced_at timestamptz,
  last_synced_date date,
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.sync_state to authenticated;
grant all on public.sync_state to service_role;
alter table public.sync_state enable row level security;
drop policy if exists ss_read on public.sync_state;
create policy ss_read on public.sync_state for select using (true);
drop policy if exists ss_write on public.sync_state;
create policy ss_write on public.sync_state for all using (true) with check (true);

-- Drivers — delivery drivers (employee_code optionally links to employees).
create table if not exists public.drivers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  employee_code text,                                 -- optional link to employees
  active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.drivers to authenticated;
grant all on public.drivers to service_role;
alter table public.drivers enable row level security;
drop policy if exists drv_read on public.drivers;
create policy drv_read on public.drivers for select using (true);
drop policy if exists drv_write on public.drivers;
create policy drv_write on public.drivers for all using (true) with check (true);

-- Deliveries — one stop on a driver's day.
create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid references public.drivers(id),
  customer text,
  address text,
  scheduled_date date,
  sequence int,                                       -- stop order within the day
  status text not null default 'pending',             -- 'pending' | 'delivered' | 'skipped'
  delivered_at timestamptz,
  photo_path text,                                    -- storage path of proof photo
  odometer_start int,
  odometer_end int,
  gate_device_id text,                                -- Tuya device for "Open gate"
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists deliveries_driver_date_idx
  on public.deliveries (driver_id, scheduled_date);
grant select, insert, update, delete on public.deliveries to authenticated;
grant all on public.deliveries to service_role;
alter table public.deliveries enable row level security;
drop policy if exists del_read on public.deliveries;
create policy del_read on public.deliveries for select using (true);
drop policy if exists del_write on public.deliveries;
create policy del_write on public.deliveries for all using (true) with check (true);
