-- WMS picking: UNDO a pick that was already made (wrong bag / wrong batch / over-picked),
-- while the order is still being picked (not yet checked or dispatched). It returns the stock
-- from the DISPATCH holding bin back to the exact bin/batch it came from, decrements
-- qty_picked, and re-opens the order for picking. Mirror-image of wms_pick_from_bin.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create or replace function public.wms_unpick(p_line_id uuid, p_qty numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line wms_order_lines; v_order wms_orders; v_name text; v_dispatch uuid;
  v_left numeric; v_take numeric; v_disp wms_stock; r record;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to undo a pick'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Undo quantity must be greater than zero'; end if;
  select * into v_line from wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from wms_orders where id = v_line.order_id;
  if v_order.status not in ('Picking','Picked','Reserved') then
    raise exception 'Can only undo a pick before the order is checked/dispatched (status is %)', v_order.status;
  end if;
  if p_qty > coalesce(v_line.qty_picked, 0) then
    raise exception 'Only % already picked on this line — cannot undo more than that', coalesce(v_line.qty_picked, 0);
  end if;
  select full_name into v_name from profiles where id = auth.uid();
  select id into v_dispatch from wms_locations where warehouse_code='8BT' and code='DISPATCH';
  if v_dispatch is null then raise exception 'DISPATCH holding bin is missing'; end if;

  -- Reverse the most-recent picks for this line's item on this order first (LIFO), sending each
  -- lot from DISPATCH back to the bin/batch it was picked from.
  v_left := p_qty;
  for r in
    select * from wms_stock_moves
    where warehouse_code='8BT' and move_type='pick' and reference = v_order.order_no and item_code = v_line.item_code
    order by created_at desc, id desc
  loop
    exit when v_left <= 0;
    if r.from_location_id is null then continue; end if;
    v_take := least(v_left, r.quantity);

    select * into v_disp from wms_stock
      where warehouse_code='8BT' and item_code=v_line.item_code and location_id=v_dispatch and batch_no=coalesce(r.batch_no,'');
    if not found or v_disp.quantity < v_take then
      raise exception 'Those bags have already left the DISPATCH bin — cannot undo (already dispatched?)';
    end if;
    update wms_stock set quantity = quantity - v_take, updated_at = now() where id = v_disp.id;
    delete from wms_stock where id = v_disp.id and quantity <= 0;

    insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values ('8BT', v_line.item_id, v_line.item_code, v_line.description, r.from_location_id, r.from_location_code, coalesce(r.batch_no,''), r.exp_date, v_take, v_line.uom)
    on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(wms_stock.exp_date, excluded.exp_date), updated_at = now();

    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT','unpick', v_line.item_id, v_line.item_code, v_line.description,
      v_dispatch, 'DISPATCH', r.from_location_id, r.from_location_code, coalesce(r.batch_no,''), r.exp_date, v_take,
      v_order.order_no, auth.uid(), v_name);

    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then
    raise exception 'Could not trace % of the picked stock back to a source bin — reconcile the rest via a stock adjustment', v_left;
  end if;

  update wms_order_lines set qty_picked = greatest(0, coalesce(qty_picked,0) - p_qty) where id = p_line_id;
  -- Re-open the order: still-picked → Picking; nothing picked left → Reserved.
  update wms_orders o set status = case
      when exists (select 1 from wms_order_lines wl where wl.order_id=o.id and coalesce(wl.qty_picked,0) > 0) then 'Picking'
      else 'Reserved' end,
    pick_completed_at = null
    where o.id = v_line.order_id and o.status in ('Picking','Picked');
  return jsonb_build_object('unpicked', p_qty);
end $$;
grant execute on function public.wms_unpick(uuid, numeric) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
