-- Audit stamping for the HR attendance-override tables.
-- ----------------------------------------------------------------------------
-- These money-sensitive overrides (OT exclusions, manual leave, late excuses, etc.)
-- recorded only a timestamp, no actor — so a payroll-affecting change wasn't
-- attributable. Add the actor columns; the routes stamp them from the AUTHENTICATED
-- caller (auth.userId / full_name), never client-supplied.
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- ============================================================================

-- Upsert tables (carry updated_at) → who last set it.
alter table public.attendance_day_flags       add column if not exists updated_by uuid, add column if not exists updated_by_name text;
alter table public.leave_days                  add column if not exists updated_by uuid, add column if not exists updated_by_name text;
alter table public.late_excuses                add column if not exists updated_by uuid, add column if not exists updated_by_name text;
alter table public.late_deduction_overrides    add column if not exists updated_by uuid, add column if not exists updated_by_name text;
alter table public.ot_month_off                add column if not exists updated_by uuid, add column if not exists updated_by_name text;
alter table public.sunday_no_contra            add column if not exists updated_by uuid, add column if not exists updated_by_name text;
alter table public.driver_trip_overrides       add column if not exists updated_by uuid, add column if not exists updated_by_name text;

-- Insert-only table (carries created_at) → who created it.
alter table public.outstation_trips            add column if not exists created_by uuid, add column if not exists created_by_name text;

notify pgrst, 'reload schema';
