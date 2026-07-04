-- 2026-07 · Lock down the HR / driver tables' Row Level Security.
-- ============================================================================
-- WHY: the HR schema (db/easwari-schema.sql and the matching section of
-- migrations.sql) shipped with wide-open policies — `for select using (true)`
-- and `for all using (true) with check (true)`. Because the browser holds the
-- public anon key, that let ANYONE read and write all payroll / attendance data
-- directly against Supabase, bypassing the app. This migration closes that.
--
-- AFTER this runs:
--   • READS require a signed-in user who has the relevant module's `view`
--     permission (admins always pass). Anonymous callers get nothing.
--   • WRITES have no policy at all → they are denied for `anon` and
--     `authenticated`. All legitimate writes go through the /api routes, which
--     use the SERVICE ROLE key (that role bypasses RLS) AND now verify the
--     caller server-side (see lib/apiAuth.ts). So writes are still gated — just
--     in the app layer, where the permission checks live — not wide open in the DB.
--
-- SAFE TO RE-RUN: idempotent. Drops whatever policies currently exist on each
-- target table (by name, from pg_catalog) before creating the locked ones, and
-- skips any table that doesn't exist in this database.
--
-- ORDER: run this AFTER the base HR tables exist. It is self-contained (defines
-- its own predicate) and does not depend on has_perm() / my_factory_code().
-- NOTE: re-running db/easwari-schema.sql after this will re-open the tables
--       (its policies are `using (true)`); run this migration last.
-- ============================================================================

-- Predicate: does the current caller have `view` on p_module?
-- SECURITY DEFINER so it can read profiles regardless of that table's own RLS.
-- Anonymous → auth.uid() is null → no row → false (fails closed).
create or replace function public.app_can_view(p_module text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles pr
    where pr.id = auth.uid()
      and (
        pr.role = 'admin'
        or coalesce(((pr.permissions -> p_module) ->> 'view')::boolean, false)
      )
  )
$$;
grant execute on function public.app_can_view(text) to authenticated, anon, service_role;

do $$
declare
  t         text;
  pol       record;
  -- Tables whose reads require the HR module.
  hr_tables text[] := array[
    'shift_profiles', 'employees', 'attendance_punches', 'attendance_reviews',
    'attendance_day_flags', 'leave_days', 'late_excuses', 'late_deduction_overrides',
    'ot_month_off', 'outstation_trips', 'driver_trip_overrides', 'public_holidays',
    'sync_state'
  ];
  -- Driver-domain tables: readable by HR staff OR the drivers themselves.
  drv_tables text[] := array['drivers', 'deliveries'];
begin
  -- HR tables ---------------------------------------------------------------
  foreach t in array hr_tables loop
    if to_regclass('public.' || t) is null then
      continue;   -- table not present in this database → skip
    end if;
    execute format('alter table public.%I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', pol.policyname, t);
    end loop;
    -- Read: signed-in HR viewers only. No write policy → writes are service-role only.
    execute format(
      'create policy %I on public.%I for select using (public.app_can_view(''hr''))',
      t || '_read', t
    );
  end loop;

  -- Driver-domain tables ----------------------------------------------------
  foreach t in array drv_tables loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', pol.policyname, t);
    end loop;
    execute format(
      'create policy %I on public.%I for select using (public.app_can_view(''hr'') or public.app_can_view(''driver''))',
      t || '_read', t
    );
  end loop;
end $$;
