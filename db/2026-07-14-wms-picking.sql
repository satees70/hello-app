-- WMS Module 3b (part 2): directed picking.
-- Run in the Supabase SQL editor. Adds ONE function (wms_pick_line). Idempotent.
--
-- Picks p_qty of an order line: allocates from warehouse stock — SL (pick) bins
-- first, then others as fallback — earliest-expiry-first (FEFO), in walking order.
-- Decrements the bins, logs a 'pick' move per bin (the "results out" trail), bumps
-- the line's qty_picked, and moves the order to Picking / Picked. Never blocks on
-- short stock: it picks what's there and reports the shortfall.

create or replace function public.wms_pick_line(p_line_id uuid, p_qty numeric, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line   wms_order_lines;
  v_order  wms_orders;
  v_name   text;
  v_need   numeric;
  v_picked numeric := 0;
  v_take   numeric;
  v_allocs jsonb := '[]'::jsonb;
  r record;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to pick warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Pick quantity must be greater than zero'; end if;

  select * into v_line from wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from wms_orders where id = v_line.order_id;
  select full_name into v_name from profiles where id = auth.uid();

  v_need := p_qty;

  for r in
    select s.id, s.location_id, s.location_code, s.batch_no, s.exp_date, s.quantity
    from wms_stock s
    join wms_locations l on l.id = s.location_id
    where s.warehouse_code = '8BT' and s.item_code = v_line.item_code and s.quantity > 0
    order by (l.location_type <> 'SL'),            -- SL pick face first, others as fallback
             s.exp_date asc nulls last,            -- first-expiry-first-out
             coalesce(l.pick_sequence, 999999), s.location_code
  loop
    exit when v_need <= 0;
    v_take := least(r.quantity, v_need);

    update wms_stock set quantity = quantity - v_take, updated_at = now() where id = r.id;
    delete from wms_stock where id = r.id and quantity <= 0;

    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'pick', v_line.item_id, v_line.item_code, v_line.description,
      r.location_id, r.location_code, r.batch_no, r.exp_date, v_take,
      coalesce(p_reference, v_order.order_no), auth.uid(), v_name);

    v_allocs := v_allocs || jsonb_build_object('bin', r.location_code, 'batch', r.batch_no, 'exp', r.exp_date, 'qty', v_take);
    v_picked := v_picked + v_take;
    v_need := v_need - v_take;
  end loop;

  update wms_order_lines set qty_picked = qty_picked + v_picked where id = p_line_id;

  -- Order status: Picked when every line is fully picked, else Picking once any pick happened.
  update wms_orders o set status = case
      when not exists (select 1 from wms_order_lines wl where wl.order_id = o.id and wl.qty_picked < wl.quantity) then 'Picked'
      when exists (select 1 from wms_order_lines wl where wl.order_id = o.id and wl.qty_picked > 0) then 'Picking'
      else o.status end
    where o.id = v_line.order_id;

  return jsonb_build_object('picked', v_picked, 'shortfall', greatest(v_need, 0), 'allocations', v_allocs);
end $$;
grant execute on function public.wms_pick_line(uuid, numeric, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
