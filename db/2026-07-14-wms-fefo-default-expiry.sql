-- WMS: for FEFO ordering only, treat a batch with NO expiry as expiring 1 year
-- after it was received (wms_stock.created_at). Nothing is stored or shown — the
-- exp_date stays null everywhere; this only affects the "earliest expiry first"
-- sort in reserve / replenish / auto-pick.  Run in Supabase. Idempotent.
-- Effective expiry expression: coalesce(s.exp_date, (s.created_at + interval '1 year')::date)

create or replace function public.wms_reserve_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text; ln record; r record; v_need numeric; v_take numeric; v_resd numeric; v_avail numeric; v_reserved numeric := 0; v_short numeric := 0;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to reserve stock'; end if;
  if not exists (select 1 from wms_orders where id = p_order_id) then raise exception 'Order not found'; end if;
  select full_name into v_name from profiles where id = auth.uid();
  for ln in select * from wms_order_lines where order_id = p_order_id loop
    v_need := ln.quantity - ln.qty_picked - coalesce((select sum(qty) from wms_reservations where order_line_id = ln.id and status='active'), 0);
    if v_need <= 0 then continue; end if;
    for r in
      select s.location_id, s.location_code, s.batch_no, s.exp_date, s.quantity
      from wms_stock s join wms_locations l on l.id = s.location_id
      where s.warehouse_code='8BT' and s.item_code = ln.item_code and s.quantity > 0 and l.location_type <> 'STAGE'
      order by (l.location_type <> 'SL'), coalesce(s.exp_date, (s.created_at + interval '1 year')::date) asc, coalesce(l.pick_sequence,999999), s.location_code
    loop
      exit when v_need <= 0;
      select coalesce(sum(qty),0) into v_resd from wms_reservations
        where status='active' and item_code = ln.item_code and location_id = r.location_id and batch_no = r.batch_no;
      v_avail := r.quantity - v_resd;
      if v_avail <= 0 then continue; end if;
      v_take := least(v_avail, v_need);
      insert into wms_reservations (order_id, order_line_id, item_id, item_code, location_id, location_code, batch_no, exp_date, qty, created_by, created_by_name)
        values (p_order_id, ln.id, ln.item_id, ln.item_code, r.location_id, r.location_code, r.batch_no, r.exp_date, v_take, auth.uid(), v_name);
      v_reserved := v_reserved + v_take; v_need := v_need - v_take;
    end loop;
    v_short := v_short + greatest(v_need, 0);
  end loop;
  update wms_orders set status='Reserved' where id = p_order_id and status in ('Review','Released','Reserved');
  return jsonb_build_object('reserved', v_reserved, 'shortfall', v_short);
end $$;
grant execute on function public.wms_reserve_order(uuid) to authenticated, anon, service_role;

create or replace function public.wms_replenish(p_item_code text, p_to_location_id uuid, p_qty numeric, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text; v_to_code text; v_need numeric; v_moved numeric := 0; v_take numeric; v_allocs jsonb := '[]'::jsonb; r record;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to move warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  select code into v_to_code from wms_locations where id = p_to_location_id;
  if v_to_code is null then raise exception 'Destination bin is not in the Location Map'; end if;
  select full_name into v_name from profiles where id = auth.uid();
  v_need := p_qty;
  for r in
    select s.id, s.location_id, s.location_code, s.batch_no, s.exp_date, s.quantity, s.item_id, s.description, s.uom
    from wms_stock s join wms_locations l on l.id = s.location_id
    where s.warehouse_code = '8BT' and s.item_code = p_item_code and s.quantity > 0
      and l.location_type = 'XS' and s.location_id <> p_to_location_id
    order by coalesce(s.exp_date, (s.created_at + interval '1 year')::date) asc, coalesce(l.pick_sequence, 999999), s.location_code
  loop
    exit when v_need <= 0;
    v_take := least(r.quantity, v_need);
    update wms_stock set quantity = quantity - v_take, updated_at = now() where id = r.id;
    delete from wms_stock where id = r.id and quantity <= 0;
    insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values ('8BT', r.item_id, p_item_code, r.description, p_to_location_id, v_to_code, r.batch_no, r.exp_date, v_take, r.uom)
    on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(wms_stock.exp_date, excluded.exp_date), updated_at = now();
    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'transfer', r.item_id, p_item_code, r.description,
      r.location_id, r.location_code, p_to_location_id, v_to_code, r.batch_no, r.exp_date, v_take,
      coalesce(p_reference, 'replenish'), auth.uid(), v_name);
    v_allocs := v_allocs || jsonb_build_object('from', r.location_code, 'batch', r.batch_no, 'qty', v_take);
    v_moved := v_moved + v_take; v_need := v_need - v_take;
  end loop;
  return jsonb_build_object('moved', v_moved, 'shortfall', greatest(v_need, 0), 'allocations', v_allocs);
end $$;
grant execute on function public.wms_replenish(text, uuid, numeric, text) to authenticated, anon, service_role;

create or replace function public.wms_pick_line(p_line_id uuid, p_qty numeric, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line wms_order_lines; v_order wms_orders; v_name text;
  v_need numeric; v_picked numeric := 0; v_take numeric; v_allocs jsonb := '[]'::jsonb; v_dispatch uuid; r record;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to pick warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Pick quantity must be greater than zero'; end if;
  select * into v_line from wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from wms_orders where id = v_line.order_id;
  select full_name into v_name from profiles where id = auth.uid();
  select id into v_dispatch from wms_locations where warehouse_code='8BT' and code='DISPATCH';
  v_need := p_qty;
  for r in
    select s.id, s.location_id, s.location_code, s.batch_no, s.exp_date, s.quantity
    from wms_stock s join wms_locations l on l.id = s.location_id
    where s.warehouse_code = '8BT' and s.item_code = v_line.item_code and s.quantity > 0 and l.location_type <> 'STAGE'
    order by (l.location_type <> 'SL'), coalesce(s.exp_date, (s.created_at + interval '1 year')::date) asc, coalesce(l.pick_sequence, 999999), s.location_code
  loop
    exit when v_need <= 0;
    v_take := least(r.quantity, v_need);
    update wms_stock set quantity = quantity - v_take, updated_at = now() where id = r.id;
    delete from wms_stock where id = r.id and quantity <= 0;
    if v_dispatch is not null then
      insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity)
      values ('8BT', v_line.item_id, v_line.item_code, v_line.description, v_dispatch, 'DISPATCH', r.batch_no, r.exp_date, v_take)
      on conflict (warehouse_code, item_code, location_id, batch_no)
      do update set quantity = wms_stock.quantity + excluded.quantity, updated_at = now();
    end if;
    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'pick', v_line.item_id, v_line.item_code, v_line.description,
      r.location_id, r.location_code, v_dispatch, 'DISPATCH', r.batch_no, r.exp_date, v_take, coalesce(p_reference, v_order.order_no), auth.uid(), v_name);
    v_allocs := v_allocs || jsonb_build_object('bin', r.location_code, 'batch', r.batch_no, 'qty', v_take);
    v_picked := v_picked + v_take; v_need := v_need - v_take;
  end loop;
  update wms_order_lines set qty_picked = qty_picked + v_picked where id = p_line_id;
  update wms_orders o set status = case
      when not exists (select 1 from wms_order_lines wl where wl.order_id = o.id and wl.qty_picked < wl.quantity) then 'Picked'
      when exists (select 1 from wms_order_lines wl where wl.order_id = o.id and wl.qty_picked > 0) then 'Picking'
      else o.status end
    where o.id = v_line.order_id;
  return jsonb_build_object('picked', v_picked, 'shortfall', greatest(v_need, 0), 'allocations', v_allocs);
end $$;
grant execute on function public.wms_pick_line(uuid, numeric, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
