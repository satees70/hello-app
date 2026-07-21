-- Free reservations that are no longer needed (pick finished / order dispatched or cancelled).
-- ----------------------------------------------------------------------------
-- THE BUG: a reservation only ever got freed if stock was picked from the EXACT bin it was
-- reserved at (wms_pick_from_bin consumes that one) — and dispatch/cancel freed nothing at all.
-- So whenever a line was picked from a different bin, or an order was dispatched/cancelled, its
-- leftover reservations stayed status='active' forever, permanently locking that stock away from
-- every other order. That is the root of the "physically there but system says no stock" problem
-- (over-reserved bins) and of the stale/orphaned reservation pile-up.
--
-- FIX (additive triggers — no rewrite of the large pick/dispatch functions, which have many
-- overlapping definitions):
--   1. When an order LINE becomes fully picked, release that line's remaining active reservations.
--   2. When an ORDER reaches a terminal status (Dispatched / Cancelled), release its remaining
--      active reservations.
-- Plus a one-time cleanup of the reservations already stranded by the old behaviour.
--
-- Releasing frees the stock for other orders; it never moves stock and never touches a reservation
-- that was properly consumed at pick. Partially-dispatched orders are left alone (their remaining
-- lines may still legitimately hold stock); genuinely-dead orders that were never picked are NOT
-- auto-cancelled here — clear those from Warehouse → Stale reservations.
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- ============================================================================

-- 1) Line fully picked → release its leftover active reservations ---------------------------
create or replace function public.wms_release_line_reservations_on_pick() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Fired only on the transition into "fully picked" (guards against re-firing and against unpick).
  if coalesce(NEW.quantity, 0) > 0
     and coalesce(NEW.qty_picked, 0) >= coalesce(NEW.quantity, 0)
     and coalesce(OLD.qty_picked, 0) <  coalesce(OLD.quantity, 0) then
    update public.wms_reservations
      set status = 'released', released_at = now()
      where order_line_id = NEW.id and status = 'active';
  end if;
  return NEW;
end $$;
drop trigger if exists trg_wms_release_line_res on public.wms_order_lines;
create trigger trg_wms_release_line_res after update of qty_picked, quantity on public.wms_order_lines
  for each row execute function public.wms_release_line_reservations_on_pick();

-- 2) Order dispatched / cancelled → release its remaining active reservations ----------------
create or replace function public.wms_release_order_reservations_on_close() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.status in ('Dispatched', 'Cancelled') and OLD.status is distinct from NEW.status then
    update public.wms_reservations
      set status = 'released', released_at = now()
      where order_id = NEW.id and status = 'active';
  end if;
  return NEW;
end $$;
drop trigger if exists trg_wms_release_order_res on public.wms_orders;
create trigger trg_wms_release_order_res after update of status on public.wms_orders
  for each row execute function public.wms_release_order_reservations_on_close();

-- 3) One-time cleanup of reservations the old behaviour already stranded ---------------------
-- (a) reservations on lines that are already fully picked
update public.wms_reservations r
  set status = 'released', released_at = now()
  from public.wms_order_lines ol
  where r.order_line_id = ol.id and r.status = 'active'
    and coalesce(ol.quantity, 0) > 0 and coalesce(ol.qty_picked, 0) >= coalesce(ol.quantity, 0);

-- (b) reservations still active on orders that are already dispatched or cancelled
update public.wms_reservations r
  set status = 'released', released_at = now()
  from public.wms_orders o
  where r.order_id = o.id and r.status = 'active'
    and o.status in ('Dispatched', 'Cancelled');

-- Report what the cleanup freed and what genuinely-stale locks remain for HO to review.
do $$
declare v_left int;
begin
  select count(distinct r.order_id) into v_left
  from public.wms_reservations r join public.wms_orders o on o.id = r.order_id
  where r.status = 'active' and o.status in ('Reserved', 'Released', 'Picking')
    and r.created_at < now() - interval '72 hours';
  raise notice 'Reservation cleanup done. % dead-but-open order(s) still hold locks (>3 days) — review in Warehouse → Stale reservations.', v_left;
end $$;

notify pgrst, 'reload schema';
