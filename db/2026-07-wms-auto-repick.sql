-- Auto-pick when stock arrives for an order that ran short.
-- When goods are RECEIVED (a 'receipt' stock movement — supplier PO receive, or any receiving that
-- books a receipt) for an item that one or more orders are still waiting on (a picker had confirmed
-- "no stock"), the system now automatically, with no button press:
--   1. moves the needed quantity from GOODS-IN into the PENDING staging area (keeping batch),
--   2. re-opens those orders for picking (restores the outstanding qty, clears the no-stock mark),
--   3. notifies the assigned picker AND Head Office that the stock arrived and is ready to pick.
-- The rest of the received quantity stays in GOODS-IN for normal putaway. Safe to re-run.
-- Run in the Supabase SQL editor.

create or replace function public.wms_auto_repick_on_receipt() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_need numeric; v_pending uuid; v_goodsin uuid; v_move numeric; v_rem numeric; r record;
begin
  if NEW.move_type <> 'receipt' or NEW.item_code is null then return NEW; end if;

  -- Total outstanding (no-stock) demand across all orders for this item.
  select coalesce(sum(no_stock_qty), 0) into v_need
    from public.wms_order_lines
    where item_code = NEW.item_code and no_stock = true and coalesce(no_stock_qty, 0) > 0;
  if v_need <= 0 then return NEW; end if;

  select id into v_pending from public.wms_locations where warehouse_code = '8BT' and code = 'PENDING';
  select id into v_goodsin from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';

  -- 1) Stage up to the needed qty from GOODS-IN into PENDING (oldest expiry first, batch preserved).
  if v_pending is not null and v_goodsin is not null then
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
  end if;

  -- 2) Re-open every outstanding line for this item, and 3) notify.
  for r in select ol.id, ol.order_id, ol.item_code, ol.no_stock_qty, o.order_no, o.assigned_to
           from public.wms_order_lines ol join public.wms_orders o on o.id = ol.order_id
           where ol.item_code = NEW.item_code and ol.no_stock = true and coalesce(ol.no_stock_qty, 0) > 0 loop
    update public.wms_order_lines
      set quantity = coalesce(qty_picked, 0) + no_stock_qty,
          no_stock = false, no_stock_qty = null, no_stock_by = null, no_stock_by_name = null, no_stock_at = null, no_stock_note = null
      where id = r.id;
    update public.wms_orders set status = 'Picking'
      where id = r.order_id and status in ('Picked', 'Checked', 'Partially Dispatched', 'Dispatched');

    -- Head Office (sees all).
    insert into public.notifications (factory_code, type, title, body, link, ref)
      values ('HEAD_OFFICE', 'wms', '📦 Stock arrived — ready to pick',
        'Order ' || coalesce(r.order_no, '') || ' can now pick ' || r.item_code || ' (' || coalesce(r.no_stock_qty, 0)::text || ' outstanding).',
        '/wms/orders', 'autopick:' || r.id::text || ':' || NEW.id::text)
      on conflict (ref) do nothing;
    -- Assigned picker (personal).
    if r.assigned_to is not null then
      insert into public.notifications (factory_code, user_id, type, title, body, link, ref)
        values ('8BT', r.assigned_to, 'wms', '📦 Stock arrived — ready to pick',
          'Order ' || coalesce(r.order_no, '') || ' — ' || r.item_code || ' arrived, please pick.',
          '/wms/pick/' || r.order_id::text, 'autopick_p:' || r.id::text || ':' || NEW.id::text)
        on conflict (ref) do nothing;
    end if;
  end loop;

  return NEW;
exception when others then
  return NEW;   -- never block a receipt because of the auto-repick step
end $$;

drop trigger if exists trg_wms_auto_repick on public.wms_stock_moves;
create trigger trg_wms_auto_repick after insert on public.wms_stock_moves
  for each row when (NEW.move_type = 'receipt') execute function public.wms_auto_repick_on_receipt();

notify pgrst, 'reload schema';
