-- Lock PENDING stock to the order it arrived for (first-come orders no longer stolen).
-- ----------------------------------------------------------------------------
-- When stock arrives for orders stuck on "no stock", wms_auto_repick_on_receipt floats
-- it from GOODS-IN into the pickable PENDING bin and reopens the waiting lines. But it
-- never RESERVED that PENDING stock — so PENDING was a shared pool: if two orders were
-- both waiting, whichever picker reached it first took it, and the other dropped back to
-- "no stock". The stock was never locked to the order it actually arrived for.
--
-- The picking engine already enforces reservations: wms_pick_from_bin blocks the portion
-- reserved by OTHER orders and consumes the picking order's own reservation. So the fix is
-- simply to CREATE those reservations when floating stock into PENDING.
--
-- This redefines wms_auto_repick_on_receipt to:
--   1. Float GOODS-IN → PENDING up to the total still outstanding (unchanged).
--   2. Hand the PENDING stock to waiting orders OLDEST-FIRST, locking each order's share
--      with an active wms_reservation, and reopening a line ONLY for the quantity it could
--      actually be given. An order that can't be fully covered stays "no stock" for the
--      remainder instead of being falsely marked ready and then out-raced.
--
-- Head Office can still free a lock from Warehouse → Stale reservations (wms_release_order).
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run. Fixes forward only — stock
-- already sitting in PENDING is not retroactively reserved (its owner is ambiguous); it
-- settles as orders pick it or via Stale reservations.
-- Depends on db/2026-07-wms-auto-repick.sql and the PENDING bin (db/2026-07-wms-pending-area.sql).
-- ============================================================================

create or replace function public.wms_auto_repick_on_receipt() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pending uuid; v_goodsin uuid;
  v_need numeric; v_rem numeric; v_move numeric;
  v_line_need numeric; v_free numeric; v_alloc numeric; v_reopened numeric;
  r record; ol record; ps record;
begin
  if NEW.move_type <> 'receipt' or NEW.item_code is null then return NEW; end if;
  select coalesce(sum(no_stock_qty), 0) into v_need from public.wms_order_lines
    where item_code = NEW.item_code and no_stock = true and coalesce(no_stock_qty, 0) > 0;
  if v_need <= 0 then return NEW; end if;

  select id into v_pending from public.wms_locations where warehouse_code = '8BT' and code = 'PENDING';
  select id into v_goodsin from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
  if v_pending is null or v_goodsin is null then return NEW; end if;

  -- (1) Float the just-arrived stock from GOODS-IN into the pickable PENDING bin, up to the
  --     total still outstanding across every waiting order (unchanged from before).
  v_rem := v_need;
  for r in select * from public.wms_stock
           where warehouse_code = '8BT' and item_code = NEW.item_code and location_id = v_goodsin and quantity > 0
           order by exp_date nulls last, updated_at loop
    exit when v_rem <= 0;
    v_move := least(r.quantity, v_rem);
    update public.wms_stock set quantity = quantity - v_move, updated_at = now() where id = r.id;
    delete from public.wms_stock where id = r.id and quantity <= 0;
    insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values ('8BT', r.item_id, r.item_code, r.description, v_pending, 'PENDING', r.batch_no, r.exp_date, v_move, r.uom)
    on conflict (warehouse_code, item_code, location_id, batch_no)
      do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'transfer', r.item_id, r.item_code, r.description, v_goodsin, 'GOODS-IN', v_pending, 'PENDING', r.batch_no, r.exp_date, v_move,
      'Auto → PENDING (stock arrived for outstanding order)', NEW.moved_by, NEW.moved_by_name);
    v_rem := v_rem - v_move;
  end loop;

  -- (2) Hand PENDING stock to the waiting orders OLDEST-FIRST, LOCKING each order's share
  --     with an active reservation. Reopen a line only for what we could actually reserve.
  for ol in select ol.id as line_id, ol.order_id, ol.item_id, ol.item_code, ol.no_stock_qty,
                   o.order_no, o.assigned_to
            from public.wms_order_lines ol join public.wms_orders o on o.id = ol.order_id
            where ol.item_code = NEW.item_code and ol.no_stock = true and coalesce(ol.no_stock_qty, 0) > 0
            order by o.created_at asc nulls last, ol.no_stock_at asc nulls last loop
    v_line_need := ol.no_stock_qty;
    for ps in select s.batch_no, s.exp_date, s.quantity from public.wms_stock s
              where s.warehouse_code = '8BT' and s.item_code = ol.item_code and s.location_id = v_pending and s.quantity > 0
              order by s.exp_date nulls last, s.updated_at loop
      exit when v_line_need <= 0;
      -- Free = physical at that PENDING batch minus everything already reserved there (any order,
      -- including reservations we just created for earlier orders in this same loop).
      v_free := ps.quantity - coalesce((select sum(qty) from public.wms_reservations
                 where status = 'active' and item_code = ol.item_code and location_id = v_pending and batch_no = ps.batch_no), 0);
      if v_free <= 0 then continue; end if;
      v_alloc := least(v_free, v_line_need);
      insert into public.wms_reservations (order_id, order_line_id, item_id, item_code, location_id, location_code, batch_no, exp_date, qty, created_by, created_by_name)
      values (ol.order_id, ol.line_id, ol.item_id, ol.item_code, v_pending, 'PENDING', ps.batch_no, ps.exp_date, v_alloc, NEW.moved_by, NEW.moved_by_name);
      v_line_need := v_line_need - v_alloc;
    end loop;

    v_reopened := ol.no_stock_qty - v_line_need;   -- how much we actually locked for this order
    if v_reopened > 0 then
      update public.wms_order_lines
        set quantity          = coalesce(qty_picked, 0) + v_reopened,
            no_stock          = case when v_line_need > 0 then true else false end,
            no_stock_qty      = case when v_line_need > 0 then v_line_need else null end,
            no_stock_by       = case when v_line_need > 0 then no_stock_by else null end,
            no_stock_by_name  = case when v_line_need > 0 then no_stock_by_name else null end,
            no_stock_at       = case when v_line_need > 0 then no_stock_at else null end,
            no_stock_note     = case when v_line_need > 0 then no_stock_note else null end
        where id = ol.line_id;
      update public.wms_orders set status = 'Picking'
        where id = ol.order_id and status in ('Picked', 'Checked', 'Partially Dispatched', 'Dispatched');
      insert into public.notifications (factory_code, type, title, body, link, ref)
        values ('HEAD_OFFICE', 'wms', '📦 Stock arrived — reserved & ready to pick',
          'Order ' || coalesce(ol.order_no, '') || ' — ' || v_reopened::text || ' of ' || ol.item_code || ' reserved and ready to pick.',
          '/wms/orders', 'autopick:' || ol.line_id::text || ':' || NEW.id::text)
        on conflict (ref) do nothing;
      if ol.assigned_to is not null then
        insert into public.notifications (factory_code, user_id, type, title, body, link, ref)
          values ('8BT', ol.assigned_to, 'wms', '📦 Stock arrived — ready to pick',
            'Order ' || coalesce(ol.order_no, '') || ' — ' || ol.item_code || ' reserved for you, please pick.',
            '/wms/pick/' || ol.order_id::text, 'autopick_p:' || ol.line_id::text || ':' || NEW.id::text)
          on conflict (ref) do nothing;
      end if;
    end if;
  end loop;
  return NEW;
exception when others then
  return NEW;   -- never block a receipt on a repick hiccup (unchanged safety net)
end $$;

drop trigger if exists trg_wms_auto_repick on public.wms_stock_moves;
create trigger trg_wms_auto_repick after insert on public.wms_stock_moves
  for each row when (NEW.move_type = 'receipt') execute function public.wms_auto_repick_on_receipt();

notify pgrst, 'reload schema';
