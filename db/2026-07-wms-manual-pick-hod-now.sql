-- Head Office can fill (pick) stock immediately, allowing negative on-hand — no approval queue.
-- ----------------------------------------------------------------------------
-- While physical stock is being reconciled the system on-hand can't be trusted, so Head Office
-- needs to push a pick through even when the system shows no/short stock. The manual-fill flow
-- already books exactly this — a real pick OUT that goes negative by the discrepancy, for a stock
-- count to reconcile later — it just required a separate approval step. This lets an HO/admin do
-- it in ONE step: it records the same audited request (approved by them) and books it immediately,
-- REUSING request_wms_manual_pick + approve_wms_manual_pick so the booking, the no-stock-line
-- handling, and the audit trail stay byte-for-byte identical to the reviewed path.
--
-- Run in the Supabase SQL editor. Safe to re-run. Depends on db/2026-07-wms-manual-pick-nostock.sql.
-- ============================================================================

create or replace function public.wms_manual_pick_now(p_line_id uuid, p_qty numeric, p_location_id uuid, p_batch text default null, p_note text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can fill stock directly'; end if;
  -- request_* validates qty vs outstanding (incl. no-stock lines) and writes the audited row;
  -- approve_* books the real pick OUT (allowing negative) and settles the line + order status.
  v_id := public.request_wms_manual_pick(p_line_id, p_qty, p_location_id, p_batch, p_note);
  perform public.approve_wms_manual_pick(v_id);
end $$;
grant execute on function public.wms_manual_pick_now(uuid, numeric, uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
