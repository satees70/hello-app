-- WMS EXPIRY ENFORCEMENT for picking + dispatch.
-- Run in the Supabase SQL editor. Idempotent (create or replace / drop if exists).
--
-- Why: the system is FEFO (offers earliest-expiry first) but nothing stopped staff from
-- picking or shipping an ALREADY-EXPIRED lot. Policy (confirmed by the owner):
--   * Expired = exp_date IS NOT NULL AND exp_date < current_date. Stock with NO expiry
--     date is NEVER treated as expired (stays fully pickable).
--   * Auto-FEFO (reserve / replenish / auto pick-line) must NEVER auto-select an expired lot.
--   * Picking or dispatching an expired lot is BLOCKED for normal staff; Head Office / admin
--     (is_ho_or_admin()) can override with a typed reason, recorded on the stock move.
--   * Near-expiry (<=180 days) is a non-blocking warning shown in the UI only.
--
-- These functions are reproduced FAITHFULLY from their current definitions and ONLY the
-- expired-exclusion predicate / override logic is added:
--   wms_reserve_order  <- db/2026-07-wms-pickable-stop.sql   (latest)
--   wms_replenish      <- db/2026-07-14-wms-fefo-default-expiry.sql (latest)
--   wms_pick_line      <- db/2026-07-14-wms-fefo-default-expiry.sql (latest)
--   wms_pick_from_bin  <- db/2026-07-wms-pickable-stop.sql   (latest) + override params
--   wms_dispatch_order <- db/2026-07-wms-order-check.sql     (latest) + override params
-- The expired-exclusion predicate everywhere is:  (s.exp_date is null or s.exp_date >= current_date)

-- ============================================================
-- 1) AUTOMATIC ALLOCATION — exclude expired lots from selection.
-- ============================================================

-- wms_reserve_order: FEFO-reserve available stock, now skipping expired lots.
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
        and (s.exp_date is null or s.exp_date >= current_date)   -- never auto-reserve an expired lot
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

-- wms_replenish: FEFO bin-to-bin top-up, now skipping expired lots.
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
      and (s.exp_date is null or s.exp_date >= current_date)   -- never auto-replenish an expired lot
    order by coalesce(s.exp_date, case when s.batch_no ~ '^[0-9]{6}' then (to_date(substring(s.batch_no from 1 for 6), 'YYMMDD') + interval '1 year')::date end, (s.created_at + interval '1 year')::date) asc, coalesce(l.pick_sequence, 999999), s.location_code
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

-- wms_pick_line: auto pick a whole line (SL first, FEFO), now skipping expired lots.
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
      and (s.exp_date is null or s.exp_date >= current_date)   -- never auto-pick an expired lot
    order by (l.location_type <> 'SL'), coalesce(s.exp_date, case when s.batch_no ~ '^[0-9]{6}' then (to_date(substring(s.batch_no from 1 for 6), 'YYMMDD') + interval '1 year')::date end, (s.created_at + interval '1 year')::date) asc, coalesce(l.pick_sequence, 999999), s.location_code
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

-- ============================================================
-- 2) MANUAL SINGLE-LOT PICK — block expired unless Head Office overrides with a reason.
--    New params p_override_expiry / p_override_reason default so existing 5-arg callers still work.
-- ============================================================
drop function if exists public.wms_pick_from_bin(uuid, uuid, text, numeric, text);
create or replace function public.wms_pick_from_bin(
  p_line_id uuid, p_location_id uuid, p_batch text, p_qty numeric, p_reference text default null,
  p_override_expiry boolean default false, p_override_reason text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line wms_order_lines; v_order wms_orders; v_stock wms_stock; v_name text; v_batch text := coalesce(p_batch,'');
  v_take numeric; v_dispatch uuid; v_resd_others numeric; v_avail numeric; v_left numeric; r record;
  v_reason text; v_ref text;
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

  -- Expiry enforcement: a lot with an expiry date in the past is blocked unless Head Office overrides.
  if v_stock.exp_date is not null and v_stock.exp_date < current_date then
    if not is_ho_or_admin() then
      raise exception 'This lot is expired — only Head Office can release it.';
    end if;
    v_reason := nullif(btrim(p_override_reason), '');
    if not coalesce(p_override_expiry, false) or v_reason is null then
      raise exception 'Expired lot — Head Office must confirm with a reason.';
    end if;
  end if;

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

  -- Record the override reason on the pick move's reference (audit trail).
  v_ref := coalesce(p_reference, v_order.order_no);
  if v_reason is not null then v_ref := coalesce(v_ref || ' · ', '') || 'EXPIRY OVERRIDE: ' || v_reason; end if;

  insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT','pick', v_line.item_id, v_line.item_code, v_line.description,
    v_stock.location_id, v_stock.location_code, v_dispatch, 'DISPATCH', v_batch, v_stock.exp_date, v_take,
    v_ref, auth.uid(), v_name);

  update wms_order_lines set qty_picked = qty_picked + v_take where id = p_line_id;
  update wms_orders o set status = case
      when not exists (select 1 from wms_order_lines wl where wl.order_id=o.id and wl.qty_picked < wl.quantity) then 'Picked'
      when exists (select 1 from wms_order_lines wl where wl.order_id=o.id and wl.qty_picked > 0) then 'Picking'
      else o.status end
    where o.id = v_line.order_id;

  return jsonb_build_object('picked', v_take, 'requested', p_qty);
end $$;
grant execute on function public.wms_pick_from_bin(uuid, uuid, text, numeric, text, boolean, text) to authenticated, anon, service_role;

-- ============================================================
-- 3) DISPATCH — block shipping an expired lot unless Head Office overrides with a reason.
--    New params p_override_expiry / p_override_reason default so existing 5-arg callers still work.
-- ============================================================
drop function if exists public.wms_dispatch_order(uuid, text, text, text, jsonb);
create or replace function public.wms_dispatch_order(
  p_order_id uuid, p_vehicle text, p_driver text, p_remark text, p_lines jsonb,
  p_override_expiry boolean default false, p_override_reason text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text; v_order wms_orders; v_do text; v_disp uuid; v_dispatch uuid; el jsonb;
  v_item text; v_batch text; v_qty numeric; v_left numeric; v_itemid uuid; v_desc text; v_exp date; v_uom text; v_full boolean;
  v_doid uuid; el2 jsonb; v_lines int := 0;
  v_reason text; v_has_expired boolean; v_remark text; v_lineexp boolean; v_ref text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to dispatch'; end if;
  select * into v_order from wms_orders where id = p_order_id; if not found then raise exception 'Order not found'; end if;
  if v_order.status not in ('Checked','Partially Dispatched') then
    raise exception 'This order must be checked before it can be dispatched (status is %)', v_order.status;
  end if;

  -- Expiry enforcement: if any line being shipped is an expired lot, block unless Head Office overrides.
  v_reason := nullif(btrim(p_override_reason), '');
  v_has_expired := exists (
    select 1 from jsonb_array_elements(p_lines) e
    where nullif(e->>'exp_date','') is not null
      and (e->>'exp_date')::date < current_date
      and coalesce((e->>'qty')::numeric, 0) > 0);
  if v_has_expired then
    if not is_ho_or_admin() then
      raise exception 'This shipment includes an expired lot — only Head Office can release it.';
    end if;
    if not coalesce(p_override_expiry, false) or v_reason is null then
      raise exception 'Expired lot in this dispatch — Head Office must confirm with a reason.';
    end if;
  end if;

  select full_name into v_name from profiles where id = auth.uid();
  select id into v_dispatch from wms_locations where warehouse_code='8BT' and code='DISPATCH';
  v_do := 'WDO-' || lpad(nextval('wms_do_seq')::text, 6, '0');

  -- Record the override reason on the dispatch record's remark (audit trail).
  v_remark := nullif(p_remark,'');
  if v_reason is not null then v_remark := coalesce(v_remark || ' · ', '') || 'EXPIRY OVERRIDE: ' || v_reason; end if;

  insert into wms_dispatches (do_number, order_id, customer_name, order_no, vehicle, driver, remark, dispatched_by, dispatched_by_name)
    values (v_do, p_order_id, v_order.customer_name, v_order.order_no, nullif(p_vehicle,''), nullif(p_driver,''), v_remark, auth.uid(), v_name)
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
      -- Tag expired-line moves with the override reason for the audit trail.
      v_lineexp := (v_exp is not null and v_exp < current_date);
      v_ref := v_do || ' / ' || coalesce(v_order.order_no,'')
               || case when v_lineexp and v_reason is not null then ' · EXPIRY OVERRIDE: ' || v_reason else '' end;
      insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
        values ('8BT','dispatch', v_itemid, v_item, v_desc, v_dispatch, 'DISPATCH', v_batch, v_exp, v_qty, v_ref, auth.uid(), v_name);
    end if;
  end loop;

  v_full := not exists (
    select 1 from wms_order_lines ol
    where ol.order_id = p_order_id
      and ol.quantity > coalesce((select sum(dl.qty) from wms_dispatch_lines dl join wms_dispatches d on d.id = dl.dispatch_id
                                  where d.order_id = p_order_id and dl.order_line_id = ol.id), 0)
  );
  update wms_orders set status = case when v_full then 'Dispatched' else 'Partially Dispatched' end where id = p_order_id;

  -- Production hand-off: land the shipment in the factory's Goods Received.
  if v_order.source = 'production' and v_order.factory_code is not null then
    insert into delivery_orders (file_name, file_path, do_number, factory_code, status, pick_run_no)
      values (v_do, 'internal:production', v_do, v_order.factory_code, 'Review', v_order.pick_run)
      returning id into v_doid;
    for el2 in select jsonb_array_elements(p_lines) loop
      if (el2->>'item_code') is null or coalesce((el2->>'qty')::numeric, 0) <= 0 then continue; end if;
      insert into delivery_order_lines (do_id, item_code, description, quantity, unit, batch_no)
        values (v_doid, el2->>'item_code', el2->>'description', (el2->>'qty')::numeric, el2->>'uom', nullif(el2->>'batch_no',''));
      v_lines := v_lines + 1;
    end loop;
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (v_order.factory_code, 'info', 'Materials arriving from warehouse',
      'Delivery ' || v_do || ' (' || v_lines || ' item(s)) is ready to receive in Goods Received'
        || case when v_order.pick_run is not null then ' — run ' || v_order.pick_run else '' end,
      '/incoming', 'proddo:' || v_doid::text)
    on conflict (ref) do nothing;
  end if;

  return jsonb_build_object('dispatch_id', v_disp, 'do_number', v_do, 'fully_dispatched', v_full);
end $$;
grant execute on function public.wms_dispatch_order(uuid, text, text, text, jsonb, boolean, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
