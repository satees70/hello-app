-- WMS: partial dispatch — an order can ship in several deliveries (each its own DO),
-- and only closes as 'Dispatched' once every line is fully shipped. Run in Supabase.
alter table public.wms_orders drop constraint if exists wms_orders_status_check;
alter table public.wms_orders add constraint wms_orders_status_check
  check (status in ('Processing','Review','Released','Reserved','Picking','Picked','Partially Dispatched','Dispatched','Error','Cancelled'));

-- Redefine wms_dispatch_order: set 'Dispatched' only when every line is fully shipped,
-- otherwise 'Partially Dispatched'.
create or replace function public.wms_dispatch_order(p_order_id uuid, p_vehicle text, p_driver text, p_remark text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text; v_order wms_orders; v_do text; v_disp uuid; v_dispatch uuid; el jsonb;
  v_item text; v_batch text; v_qty numeric; v_left numeric; v_itemid uuid; v_desc text; v_exp date; v_uom text; v_full boolean;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to dispatch'; end if;
  select * into v_order from wms_orders where id = p_order_id; if not found then raise exception 'Order not found'; end if;
  select full_name into v_name from profiles where id = auth.uid();
  select id into v_dispatch from wms_locations where warehouse_code='8BT' and code='DISPATCH';
  v_do := 'WDO-' || lpad(nextval('wms_do_seq')::text, 6, '0');
  insert into wms_dispatches (do_number, order_id, customer_name, order_no, vehicle, driver, remark, dispatched_by, dispatched_by_name)
    values (v_do, p_order_id, v_order.customer_name, v_order.order_no, nullif(p_vehicle,''), nullif(p_driver,''), nullif(p_remark,''), auth.uid(), v_name)
    returning id into v_disp;

  for el in select jsonb_array_elements(p_lines) loop
    v_item := el->>'item_code'; v_batch := coalesce(el->>'batch_no',''); v_qty := (el->>'qty')::numeric;
    if v_item is null or v_qty is null or v_qty <= 0 then continue; end if;
    v_itemid := nullif(el->>'item_id','')::uuid; v_desc := el->>'description'; v_exp := nullif(el->>'exp_date','')::date; v_uom := el->>'uom';
    insert into wms_dispatch_lines (dispatch_id, order_line_id, item_id, item_code, description, batch_no, exp_date, qty, uom)
      values (v_disp, nullif(el->>'order_line_id','')::uuid, v_itemid, v_item, v_desc, v_batch, v_exp, v_qty, v_uom);
    if v_dispatch is not null then
      select quantity into v_left from wms_stock where warehouse_code='8BT' and item_code=v_item and location_id=v_dispatch and batch_no=v_batch;
      v_left := least(coalesce(v_left,0), v_qty);
      if v_left > 0 then
        update wms_stock set quantity = quantity - v_left, updated_at=now() where warehouse_code='8BT' and item_code=v_item and location_id=v_dispatch and batch_no=v_batch;
        delete from wms_stock where warehouse_code='8BT' and item_code=v_item and location_id=v_dispatch and batch_no=v_batch and quantity <= 0;
      end if;
      insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
        values ('8BT','dispatch', v_itemid, v_item, v_desc, v_dispatch, 'DISPATCH', v_batch, v_exp, v_qty, v_do || ' / ' || coalesce(v_order.order_no,''), auth.uid(), v_name);
    end if;
  end loop;

  -- Fully dispatched only if no line still has ordered qty > total dispatched qty.
  v_full := not exists (
    select 1 from wms_order_lines ol
    where ol.order_id = p_order_id
      and ol.quantity > coalesce((select sum(dl.qty) from wms_dispatch_lines dl join wms_dispatches d on d.id = dl.dispatch_id
                                  where d.order_id = p_order_id and dl.order_line_id = ol.id), 0)
  );
  update wms_orders set status = case when v_full then 'Dispatched' else 'Partially Dispatched' end where id = p_order_id;
  return jsonb_build_object('dispatch_id', v_disp, 'do_number', v_do, 'fully_dispatched', v_full);
end $$;
grant execute on function public.wms_dispatch_order(uuid, text, text, text, jsonb) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
