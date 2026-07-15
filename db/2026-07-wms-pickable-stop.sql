-- WMS: mark locations as pickable or not (return / quarantine bins must NOT be picked for
-- normal orders), and add an explicit "Stop picking" so KPI time = stop − start.
--
-- Reserve + pick now skip non-pickable locations; any location named like a return is set
-- non-pickable automatically. Run in the Supabase SQL editor. Safe to re-run.

alter table public.wms_locations add column if not exists pickable boolean not null default true;
-- Return / quarantine / damage locations are not for normal picking.
update public.wms_locations
  set pickable = false
  where coalesce(pickable, true)
    and (code ilike '%return%' or coalesce(label,'') ilike '%return%'
      or code ilike '%quarantine%' or code ilike '%damage%' or code ilike '%reject%');

-- Explicit stop → sets the pick end time (start comes from wms_start_picking / first pick).
create or replace function public.wms_stop_picking(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  update wms_orders set pick_completed_at = now() where id = p_order_id and pick_started_at is not null;
end $$;
grant execute on function public.wms_stop_picking(uuid) to authenticated, anon, service_role;

-- Redefine wms_pick_from_bin: refuse a non-pickable location (rest identical to the current
-- production-transfer version, incl. the production_only guard).
create or replace function public.wms_pick_from_bin(p_line_id uuid, p_location_id uuid, p_batch text, p_qty numeric, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line wms_order_lines; v_order wms_orders; v_stock wms_stock; v_name text; v_batch text := coalesce(p_batch,'');
  v_take numeric; v_dispatch uuid; v_resd_others numeric; v_avail numeric; v_left numeric; r record;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to pick warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Pick quantity must be greater than zero'; end if;
  if exists (select 1 from wms_locations where id = p_location_id and coalesce(pickable, true) = false) then
    raise exception 'That location is not pickable (a return / quarantine bin)';
  end if;
  select * into v_line from wms_order_lines where id = p_line_id; if not found then raise exception 'Order line not found'; end if;
  select * into v_order from wms_orders where id = v_line.order_id;
  select full_name into v_name from profiles where id = auth.uid();
  select id into v_dispatch from wms_locations where warehouse_code='8BT' and code='DISPATCH';
  if v_dispatch is null then raise exception 'DISPATCH holding bin is missing — run the dispatch migration'; end if;
  select * into v_stock from wms_stock where warehouse_code='8BT' and item_code=v_line.item_code and location_id=p_location_id and batch_no=v_batch;
  if not found or v_stock.quantity <= 0 then raise exception 'No stock of % in that bin/batch', v_line.item_code; end if;
  if v_stock.production_only then raise exception 'That batch is reserved for production — not available for customer dispatch'; end if;

  select coalesce(sum(qty),0) into v_resd_others from wms_reservations
    where status='active' and item_code=v_line.item_code and location_id=p_location_id and batch_no=v_batch and order_id <> v_line.order_id;
  v_avail := v_stock.quantity - v_resd_others;
  if v_avail <= 0 then raise exception 'That stock is reserved for another order'; end if;
  v_take := least(v_avail, p_qty);

  update wms_stock set quantity = quantity - v_take, updated_at = now() where id = v_stock.id;
  delete from wms_stock where id = v_stock.id and quantity <= 0;

  insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', v_line.item_id, v_line.item_code, v_line.description, v_dispatch, 'DISPATCH', v_batch, v_stock.exp_date, v_take, v_stock.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
  do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(wms_stock.exp_date, excluded.exp_date), updated_at = now();

  v_left := v_take;
  for r in select id, qty from wms_reservations where status='active' and order_id=v_line.order_id and item_code=v_line.item_code and location_id=p_location_id and batch_no=v_batch order by created_at loop
    exit when v_left <= 0;
    if r.qty <= v_left then update wms_reservations set status='consumed' where id=r.id; v_left := v_left - r.qty;
    else update wms_reservations set qty = qty - v_left where id=r.id; v_left := 0; end if;
  end loop;

  insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT','pick', v_line.item_id, v_line.item_code, v_line.description,
    v_stock.location_id, v_stock.location_code, v_dispatch, 'DISPATCH', v_batch, v_stock.exp_date, v_take,
    coalesce(p_reference, v_order.order_no), auth.uid(), v_name);

  update wms_order_lines set qty_picked = qty_picked + v_take where id = p_line_id;
  update wms_orders o set status = case
      when not exists (select 1 from wms_order_lines wl where wl.order_id=o.id and wl.qty_picked < wl.quantity) then 'Picked'
      when exists (select 1 from wms_order_lines wl where wl.order_id=o.id and wl.qty_picked > 0) then 'Picking'
      else o.status end
    where o.id = v_line.order_id;

  return jsonb_build_object('picked', v_take, 'requested', p_qty);
end $$;
grant execute on function public.wms_pick_from_bin(uuid, uuid, text, numeric, text) to authenticated, anon, service_role;

-- Redefine wms_reserve_order: skip non-pickable locations (rest identical).
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
        and coalesce(s.production_only,false) = false and coalesce(l.pickable,true) = true
      order by (l.location_type <> 'SL'), s.exp_date asc nulls last, coalesce(l.pick_sequence,999999), s.location_code
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

notify pgrst, 'reload schema';
