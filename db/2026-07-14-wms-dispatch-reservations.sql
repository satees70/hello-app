-- ============================================================
-- WMS: Dispatch / Delivery Orders + Stock Reservations
-- Run in the Supabase SQL editor. Idempotent. Builds on wms_stock,
-- wms_orders, wms_reservations, wms_stock_moves.
-- Lifecycle: Reserve (on Release) → Pick (bin → DISPATCH holding) → Dispatch (out + DO).
-- ============================================================
create sequence if not exists wms_do_seq;

alter table public.wms_orders drop constraint if exists wms_orders_status_check;
alter table public.wms_orders add constraint wms_orders_status_check
  check (status in ('Processing','Review','Released','Reserved','Picking','Picked','Dispatched','Error','Cancelled'));

create table if not exists public.wms_reservations (
  id uuid primary key default gen_random_uuid(),
  warehouse_code text not null default '8BT',
  order_id uuid not null references public.wms_orders(id) on delete cascade,
  order_line_id uuid references public.wms_order_lines(id) on delete cascade,
  item_id uuid references public.items(id),
  item_code text not null,
  location_id uuid references public.wms_locations(id),
  location_code text not null,
  batch_no text not null default '',
  exp_date date,
  qty numeric not null,
  status text not null default 'active' check (status in ('active','consumed','released')),
  created_by uuid, created_by_name text, created_at timestamptz not null default now(),
  released_at timestamptz
);
create index if not exists wms_res_order on public.wms_reservations(order_id);
create index if not exists wms_res_stock on public.wms_reservations(item_code, location_id, batch_no, status);

create table if not exists public.wms_dispatches (
  id uuid primary key default gen_random_uuid(),
  warehouse_code text not null default '8BT',
  do_number text,
  order_id uuid references public.wms_orders(id) on delete set null,
  customer_name text, order_no text,
  vehicle text, driver text, remark text,
  status text not null default 'Dispatched' check (status in ('Dispatched','Cancelled')),
  dispatched_by uuid, dispatched_by_name text, dispatched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create table if not exists public.wms_dispatch_lines (
  id uuid primary key default gen_random_uuid(),
  dispatch_id uuid not null references public.wms_dispatches(id) on delete cascade,
  order_line_id uuid references public.wms_order_lines(id),
  item_id uuid references public.items(id),
  item_code text not null, description text,
  batch_no text not null default '', exp_date date,
  qty numeric not null, uom text
);
create index if not exists wms_dispatch_lines_d on public.wms_dispatch_lines(dispatch_id);

-- The DISPATCH holding bin: picked goods land here until they physically ship.
insert into public.wms_locations (warehouse_code, category, location_type, code, aisle, sql_location, label, active)
values ('8BT','Stock','STAGE','DISPATCH','DISPATCH','8BT/Stock/STAGE/DISPATCH','Dispatch holding / packed', true)
on conflict (warehouse_code, code) do nothing;

grant select, insert, update, delete on public.wms_reservations, public.wms_dispatches, public.wms_dispatch_lines to authenticated, anon, service_role;
grant usage on sequence wms_do_seq to authenticated, anon, service_role;
do $$ declare t text; begin
  foreach t in array array['wms_reservations','wms_dispatches','wms_dispatch_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (has_perm(''warehouse'',''view''))', t, t);
    execute format('create policy %I_write on public.%I for all using (has_perm(''warehouse'',''edit'')) with check (has_perm(''warehouse'',''edit''))', t, t);
  end loop;
end $$;

-- Reserve an order's stock (called when it's Released). FEFO-allocates AVAILABLE
-- stock (on-hand minus what's already reserved by anyone) into reservations pinned
-- to bin+batch, and marks the order Reserved.
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

-- Cancel an order: release its active reservations and mark it Cancelled.
create or replace function public.wms_cancel_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  update wms_reservations set status='released', released_at=now() where order_id = p_order_id and status='active';
  update wms_orders set status='Cancelled' where id = p_order_id;
end $$;
grant execute on function public.wms_cancel_order(uuid) to authenticated, anon, service_role;

-- Pick from a chosen bin/batch → moves the stock into the DISPATCH holding bin,
-- consuming this order's reservation, blocked from taking stock reserved by others.
create or replace function public.wms_pick_from_bin(p_line_id uuid, p_location_id uuid, p_batch text, p_qty numeric, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line wms_order_lines; v_order wms_orders; v_stock wms_stock; v_name text; v_batch text := coalesce(p_batch,'');
  v_take numeric; v_dispatch uuid; v_resd_others numeric; v_avail numeric; v_left numeric; r record;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to pick warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Pick quantity must be greater than zero'; end if;
  select * into v_line from wms_order_lines where id = p_line_id; if not found then raise exception 'Order line not found'; end if;
  select * into v_order from wms_orders where id = v_line.order_id;
  select full_name into v_name from profiles where id = auth.uid();
  select id into v_dispatch from wms_locations where warehouse_code='8BT' and code='DISPATCH';
  if v_dispatch is null then raise exception 'DISPATCH holding bin is missing — run the dispatch migration'; end if;
  select * into v_stock from wms_stock where warehouse_code='8BT' and item_code=v_line.item_code and location_id=p_location_id and batch_no=v_batch;
  if not found or v_stock.quantity <= 0 then raise exception 'No stock of % in that bin/batch', v_line.item_code; end if;

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

  v_left := v_take;   -- consume this order's reservation for that bin/batch
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

-- Dispatch an order: create the Delivery Order + lines from what actually ships,
-- remove those quantities from the DISPATCH holding bin, log 'dispatch' moves,
-- and mark the order Dispatched. p_lines = [{order_line_id,item_id,item_code,description,batch_no,exp_date,qty,uom}].
create or replace function public.wms_dispatch_order(p_order_id uuid, p_vehicle text, p_driver text, p_remark text, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_name text; v_order wms_orders; v_do text; v_disp uuid; v_dispatch uuid; el jsonb;
  v_item text; v_batch text; v_qty numeric; v_left numeric; v_itemid uuid; v_desc text; v_exp date; v_uom text;
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

  update wms_orders set status='Dispatched' where id = p_order_id;
  return jsonb_build_object('dispatch_id', v_disp, 'do_number', v_do);
end $$;
grant execute on function public.wms_dispatch_order(uuid, text, text, text, jsonb) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
