-- 2026-07 · Clear old / wrong finished-goods batches from "ready to send"
-- ----------------------------------------------------------------------------
-- The Dispatch "Finished goods ready to send" list shows every production batch
-- with dispatched_at IS NULL. Old batches that were delivered outside the system,
-- or wrong / test batches (e.g. qty 0.05) that will never ship, sit there forever
-- because the only way to remove one was to create a delivery order.
--
-- This adds an HO/admin-only way to CLEAR such a batch: it flips status to
-- 'Bypassed' — which the dispatch query already hides (…neq('status','Bypassed'))
-- and which the production board also hides. It does NOT touch produced_qty,
-- does NOT set dispatched_at (so no "delivered to warehouse" notification fires),
-- and moves NO stock (dispatch never moves finished-goods stock). The row stays
-- in the database for history; who/why is recorded for audit.
--
-- Run this in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

-- Audit columns (nullable — existing rows untouched).
alter table public.production_batches add column if not exists cleared_by uuid;
alter table public.production_batches add column if not exists cleared_at timestamptz;
alter table public.production_batches add column if not exists cleared_reason text;

create or replace function public.clear_fg_batches(p_ids uuid[], p_reason text default null)
  returns integer
  language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if not public.is_ho_or_admin() then
    raise exception 'Only Head Office or an admin can clear finished-goods batches';
  end if;
  -- Only clear batches that have NOT already been dispatched; leave produced_qty
  -- as-is so production reports stay truthful.
  update public.production_batches
     set status = 'Bypassed',
         cleared_by = auth.uid(),
         cleared_at = now(),
         cleared_reason = nullif(btrim(p_reason), '')
   where id = any (p_ids)
     and dispatched_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
grant execute on function public.clear_fg_batches(uuid[], text) to authenticated;
