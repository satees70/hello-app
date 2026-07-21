-- Also release a line's reservations when it's shrunk to zero (picker confirmed "no stock").
-- ----------------------------------------------------------------------------
-- Follow-up to db/2026-07-wms-release-reservations.sql. That trigger released a line's leftover
-- reservations when it became fully picked, but it was guarded with `quantity > 0` — so it skipped
-- the case where wms_confirm_no_stock shrinks a line's quantity down to qty_picked (often 0). Those
-- lines end up "no stock" yet still hold an active reservation, locking that stock from every other
-- order (e.g. SO-41790: line quantity 0 / picked 0, but 4 still reserved at B203).
--
-- The correct rule is simply: when a line has nothing left to pick (qty_picked >= quantity), it
-- should hold no active reservation — whether it got there by being picked OR by being marked short.
-- Drop the quantity>0 guard so the trigger fires on the shrink-to-zero transition too, and clean up
-- the reservations already stranded that way.
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- ============================================================================

create or replace function public.wms_release_line_reservations_on_pick() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Transition: the line had something outstanding, now it has nothing left to pick
  -- (fully picked, OR shrunk to qty_picked by a "no stock" confirmation). Either way, free its locks.
  if coalesce(NEW.qty_picked, 0) >= coalesce(NEW.quantity, 0)
     and coalesce(OLD.qty_picked, 0) < coalesce(OLD.quantity, 0) then
    update public.wms_reservations
      set status = 'released', released_at = now()
      where order_line_id = NEW.id and status = 'active';
  end if;
  return NEW;
end $$;
-- (trigger trg_wms_release_line_res already fires on update of qty_picked, quantity)

-- One-time cleanup of reservations still active on lines with nothing left to pick.
update public.wms_reservations r
  set status = 'released', released_at = now()
  from public.wms_order_lines ol
  where r.order_line_id = ol.id and r.status = 'active'
    and coalesce(ol.qty_picked, 0) >= coalesce(ol.quantity, 0);

notify pgrst, 'reload schema';
