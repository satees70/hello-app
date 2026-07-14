-- WMS: bin-to-bin transfer + replenishment.
-- Run in the Supabase SQL editor. Adds 2 functions. Idempotent.

-- Move p_qty of one item+batch from one bin to another. Caps at the source bin's
-- on-hand; logs a 'transfer' move.
create or replace function public.wms_transfer(
  p_item_code text, p_from_location_id uuid, p_from_batch text,
  p_to_location_id uuid, p_qty numeric, p_reference text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name text; v_src wms_stock; v_to_code text; v_batch text := coalesce(p_from_batch, ''); v_take numeric;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to move warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_from_location_id = p_to_location_id then raise exception 'From and To bins must be different'; end if;
  select code into v_to_code from wms_locations where id = p_to_location_id;
  if v_to_code is null then raise exception 'Destination bin is not in the Location Map'; end if;
  select * into v_src from wms_stock
    where warehouse_code = '8BT' and item_code = p_item_code and location_id = p_from_location_id and batch_no = v_batch;
  if not found or v_src.quantity <= 0 then raise exception 'No stock of % in that source bin/batch', p_item_code; end if;

  v_take := least(v_src.quantity, p_qty);
  select full_name into v_name from profiles where id = auth.uid();

  update wms_stock set quantity = quantity - v_take, updated_at = now() where id = v_src.id;
  delete from wms_stock where id = v_src.id and quantity <= 0;

  insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', v_src.item_id, p_item_code, v_src.description, p_to_location_id, v_to_code, v_batch, v_src.exp_date, v_take, v_src.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
  do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(wms_stock.exp_date, excluded.exp_date), updated_at = now();

  insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'transfer', v_src.item_id, p_item_code, v_src.description,
    v_src.location_id, v_src.location_code, p_to_location_id, v_to_code, v_batch, v_src.exp_date, v_take,
    p_reference, auth.uid(), v_name);

  return jsonb_build_object('moved', v_take, 'requested', p_qty);
end $$;
grant execute on function public.wms_transfer(text, uuid, text, uuid, numeric, text) to authenticated, anon, service_role;

-- Replenish a pick bin: pull p_qty of an item into p_to_location_id from the
-- item's XS (excess/overflow) bins, earliest-expiry first. Logs 'transfer' moves.
create or replace function public.wms_replenish(
  p_item_code text, p_to_location_id uuid, p_qty numeric, p_reference text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name text; v_to_code text; v_need numeric; v_moved numeric := 0; v_take numeric;
  v_allocs jsonb := '[]'::jsonb; r record;
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
    order by s.exp_date asc nulls last, coalesce(l.pick_sequence, 999999), s.location_code
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
    v_moved := v_moved + v_take;
    v_need := v_need - v_take;
  end loop;

  return jsonb_build_object('moved', v_moved, 'shortfall', greatest(v_need, 0), 'allocations', v_allocs);
end $$;
grant execute on function public.wms_replenish(text, uuid, numeric, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
