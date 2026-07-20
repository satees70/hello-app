-- Receiving a RETURN now books the stock into the WMS (it never did before).
-- ----------------------------------------------------------------------------
-- confirm_do_return only stamped material_returns.received_at — it never added the
-- returned goods to any ledger. So returned stock was physically back but invisible:
-- nothing in the WMS stock card, not pickable, and it also left item_stock negative
-- (the delivery '-' happened, the return '+' never did). This makes a return receipt
-- behave exactly like a normal delivery receipt: book the qty into 8BT GOODS-IN as a
-- 'receipt' move — which lets the existing wms_auto_repick trigger route it to PENDING
-- for any outstanding SO that's waiting on the item. Idempotent via wms_booked_at.
--
-- Run in the Supabase SQL editor. Safe to re-run. Includes a one-time backfill for
-- returns that were already received but never booked (e.g. DO102-2607/0043).
-- ============================================================================

alter table public.material_returns add column if not exists wms_booked_at timestamptz;   -- set once booked into WMS

-- Confirm a RETURN line (with its photo) AND book it into WMS GOODS-IN.
create or replace function public.confirm_do_return(p_return_id uuid, p_photo_path text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_do uuid; v_ret public.material_returns;
  v_item_id uuid; v_desc text; v_uom text; v_stage uuid; v_dono text; v_grn text; v_batch text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can confirm a return';
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.material_returns
     set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name,
         photo_path = coalesce(nullif(p_photo_path, ''), photo_path)
   where id = p_return_id returning * into v_ret;
  if v_ret.id is null then raise exception 'Return line not found'; end if;
  v_do := v_ret.dispatch_id;

  -- Book the returned goods into GOODS-IN — exactly once. The 'receipt' move fires the
  -- auto-repick trigger, which sends it to PENDING for any waiting outstanding order.
  if v_ret.wms_booked_at is null and coalesce(v_ret.quantity, 0) > 0 and nullif(btrim(v_ret.item_code), '') is not null then
    v_batch := coalesce(v_ret.batch_no, '');
    select id, description, unit into v_item_id, v_desc, v_uom from public.items where code = v_ret.item_code;
    select id into v_stage from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
    select do_number, warehouse_grn into v_dono, v_grn from public.dispatch_orders where id = v_do;
    if v_stage is not null then
      insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
      values ('8BT', v_item_id, v_ret.item_code, coalesce(v_ret.description, v_desc), v_stage, 'GOODS-IN', v_batch, null, v_ret.quantity, v_uom)
      on conflict (warehouse_code, item_code, location_id, batch_no)
        do update set quantity = wms_stock.quantity + excluded.quantity, updated_at = now();
      insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
        to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
      values ('8BT', 'receipt', v_item_id, v_ret.item_code, coalesce(v_ret.description, v_desc), v_stage, 'GOODS-IN', v_batch, null, v_ret.quantity,
        'DO ' || coalesce(v_dono, '') || case when nullif(v_grn, '') is not null then ' · GRN ' || v_grn else '' end || ' (return)', auth.uid(), v_name);
      update public.material_returns set wms_booked_at = now() where id = p_return_id;
    end if;
  end if;

  perform public._do_receipt_rollup(v_do, v_name);
end $$;
grant execute on function public.confirm_do_return(uuid, text) to authenticated;

-- Undo a return-line confirmation — also reverse the WMS booking (from GOODS-IN, only
-- what's still there), so a re-confirm can't double-count.
create or replace function public.unconfirm_do_return(p_return_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_do uuid; v_ret public.material_returns; v_stage uuid; v_have numeric; v_take numeric; v_batch text; v_name text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can change a return';
  end if;
  select * into v_ret from public.material_returns where id = p_return_id;
  if v_ret.id is null then raise exception 'Return line not found'; end if;
  v_do := v_ret.dispatch_id;

  if v_ret.wms_booked_at is not null and coalesce(v_ret.quantity, 0) > 0 and nullif(btrim(v_ret.item_code), '') is not null then
    v_batch := coalesce(v_ret.batch_no, '');
    select full_name into v_name from public.profiles where id = auth.uid();
    select id into v_stage from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
    select quantity into v_have from public.wms_stock where warehouse_code = '8BT' and item_code = v_ret.item_code and location_id = v_stage and batch_no = v_batch;
    if v_stage is not null and coalesce(v_have, 0) > 0 then
      v_take := least(v_have, v_ret.quantity);
      update public.wms_stock set quantity = quantity - v_take, updated_at = now() where warehouse_code = '8BT' and item_code = v_ret.item_code and location_id = v_stage and batch_no = v_batch;
      delete from public.wms_stock where warehouse_code = '8BT' and item_code = v_ret.item_code and location_id = v_stage and batch_no = v_batch and quantity <= 0;
      insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
      values ('8BT', 'adjust', (select id from public.items where code = v_ret.item_code), v_ret.item_code, v_ret.description, v_stage, 'GOODS-IN', v_batch, null, v_take, 'Undo return receipt', auth.uid(), v_name);
    end if;
    update public.material_returns set wms_booked_at = null where id = p_return_id;
  end if;

  update public.material_returns set received_at = null, received_by = null, received_by_name = null where id = p_return_id;
  if v_do is not null then update public.dispatch_orders set received_at = null where id = v_do; end if;
end $$;
grant execute on function public.unconfirm_do_return(uuid) to authenticated;

-- One-time backfill: book every return already received but not yet booked (skips any
-- that already has a return receipt move for the same DO + item).
do $$
declare r record; v_stage uuid; v_item_id uuid; v_desc text; v_uom text; v_batch text;
begin
  select id into v_stage from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
  if v_stage is null then return; end if;
  for r in
    select mr.*, d.do_number, d.warehouse_grn
    from public.material_returns mr
    join public.dispatch_orders d on d.id = mr.dispatch_id
    where mr.received_at is not null and mr.wms_booked_at is null
      and coalesce(mr.quantity, 0) > 0 and nullif(btrim(mr.item_code), '') is not null
      and not exists (
        select 1 from public.wms_stock_moves m
        where m.item_code = mr.item_code and m.move_type = 'receipt'
          and m.reference ilike '%' || d.do_number || '%return%')
  loop
    v_batch := coalesce(r.batch_no, '');
    select id, description, unit into v_item_id, v_desc, v_uom from public.items where code = r.item_code;
    insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values ('8BT', v_item_id, r.item_code, coalesce(r.description, v_desc), v_stage, 'GOODS-IN', v_batch, null, r.quantity, v_uom)
    on conflict (warehouse_code, item_code, location_id, batch_no)
      do update set quantity = wms_stock.quantity + excluded.quantity, updated_at = now();
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name, created_at)
    values ('8BT', 'receipt', v_item_id, r.item_code, coalesce(r.description, v_desc), v_stage, 'GOODS-IN', v_batch, null, r.quantity,
      'DO ' || coalesce(r.do_number, '') || case when nullif(r.warehouse_grn, '') is not null then ' · GRN ' || r.warehouse_grn else '' end || ' (return, backfill)',
      r.received_by, r.received_by_name, coalesce(r.received_at, now()));
    update public.material_returns set wms_booked_at = now() where id = r.id;
  end loop;
end $$;

notify pgrst, 'reload schema';
