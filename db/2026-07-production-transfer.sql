-- Internal Production Transfer: bridge WMS bag stock → factory kg stock.
--
-- WHY: Today production waits for the warehouse to (a) type the pick into Goods
-- Received and (b) press a separate "release/send" before it becomes factory
-- stock. This connects the two ledgers that already share one database WITHOUT
-- merging them: warehouse keeps bags (wms_stock), production keeps loose kg
-- (item_stock / stock_lots). One transfer moves bags out of WMS and books the
-- equal kg into the factory in the same step — no separate send, production sees
-- the stock instantly, and the matching Material Request auto-fills.
--
-- Rules honoured here:
--  • Separate ledgers, no stock combining — a transfer moves, never duplicates.
--  • Bag → kg via items.kg_per_bag (or the app-parsed pack size), passed in as kg.
--  • Over is allowed, short is not — enforced in the UI (confirm locked until the
--    kg tally ≥ requested). This RPC books whatever kg it is given (so a big pick
--    can be split across trips) and never forces a short line closed.
--  • Warehouse may switch which material/bag they actually send (the override) —
--    every switched line carries override_note and is logged in wms_stock_moves.
--  • A raw-material batch can be tagged "Production only" (wms_stock.production_only)
--    — WMS then HARD-BLOCKS it from customer/trading pick & dispatch.
--
-- Run in the Supabase SQL editor. Safe to re-run.

-- 1. Production-only tag on warehouse stock (the hard lock flag) -----------------
alter table public.wms_stock add column if not exists production_only boolean not null default false;

-- 2. Transfer documents ----------------------------------------------------------
create sequence if not exists public.wms_transfer_seq;

create table if not exists public.wms_production_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_no text unique,
  request_id uuid references public.material_requests(id) on delete set null,
  factory_code text not null,
  warehouse_code text not null default '8BT',
  status text not null default 'Transferred',
  note text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists wms_prod_transfers_req on public.wms_production_transfers (request_id);

create table if not exists public.wms_production_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.wms_production_transfers(id) on delete cascade,
  request_item_id uuid references public.material_request_items(id) on delete set null,
  item_id uuid,                 -- destination loose/kg item (what production consumes)
  item_code text,               -- loose/kg code
  description text,
  source_item_code text,        -- bag SKU actually picked from WMS (may differ = override)
  location_id uuid,
  location_code text,
  batch_no text,
  exp_date date,
  bags numeric not null,        -- number of bags/cartons taken (in uom)
  uom text,
  kg_per_bag numeric,           -- conversion used
  kg numeric not null,          -- bags * kg_per_bag = amount booked into production
  override_note text,           -- set when warehouse switched material/bag
  created_at timestamptz not null default now()
);
create index if not exists wms_prod_transfer_lines_tid on public.wms_production_transfer_lines (transfer_id);
create index if not exists wms_prod_transfer_lines_item on public.wms_production_transfer_lines (item_code, created_at desc);

alter table public.wms_production_transfers enable row level security;
alter table public.wms_production_transfer_lines enable row level security;
-- Read for any signed-in user whose scope can see the factory; write only via the
-- SECURITY DEFINER RPC below (which checks has_perm). No direct client writes.
drop policy if exists wms_pt_read on public.wms_production_transfers;
create policy wms_pt_read on public.wms_production_transfers for select
  using (is_ho_or_admin() or factory_code = any(my_factory_codes()) or has_perm('warehouse','view'));
drop policy if exists wms_ptl_read on public.wms_production_transfer_lines;
create policy wms_ptl_read on public.wms_production_transfer_lines for select
  using (exists (select 1 from public.wms_production_transfers t where t.id = transfer_id
    and (is_ho_or_admin() or t.factory_code = any(my_factory_codes()) or has_perm('warehouse','view'))));

-- 3. Tag / untag a warehouse stock row as "Production only" ----------------------
create or replace function public.wms_tag_production(p_stock_id uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  update public.wms_stock set production_only = coalesce(p_on,false), updated_at = now() where id = p_stock_id;
end $$;
grant execute on function public.wms_tag_production(uuid, boolean) to authenticated, anon, service_role;

-- 4. The bridge: transfer picked bags into production kg stock -------------------
-- p_lines = [{ request_item_id, item_id, item_code, source_item_code, location_id,
--              batch_no, exp_date, bags, uom, kg_per_bag, kg, override_note }]
-- For each line: take `bags` out of wms_stock, log a 'transfer' move, book `kg`
-- into stock_lots + item_stock for the request's factory, and add `kg` to the
-- Material Request line's received_qty. Then recompute the request status.
create or replace function public.wms_transfer_to_production(p_request_id uuid, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_req material_requests; v_name text; v_no text; v_tid uuid; el jsonb;
  v_src wms_stock; v_bags numeric; v_kg numeric; v_ri uuid; v_srccode text;
  v_loc uuid; v_batch text; v_itemid uuid; v_itemcode text; v_desc text;
  v_kgpb numeric; v_uom text; v_ovr text; v_lines int := 0; v_totkg numeric := 0;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to transfer to production'; end if;
  select * into v_req from material_requests where id = p_request_id;
  if not found then raise exception 'Material request not found'; end if;
  select full_name into v_name from profiles where id = auth.uid();

  v_no := 'PT-' || to_char(now(),'YYMM') || '/' || lpad(nextval('wms_transfer_seq')::text, 4, '0');
  insert into public.wms_production_transfers (transfer_no, request_id, factory_code, created_by, created_by_name)
    values (v_no, p_request_id, v_req.factory_code, auth.uid(), v_name)
    returning id into v_tid;

  for el in select jsonb_array_elements(p_lines) loop
    v_ri      := nullif(el->>'request_item_id','')::uuid;
    v_itemid  := nullif(el->>'item_id','')::uuid;
    v_itemcode:= el->>'item_code';
    v_srccode := coalesce(el->>'source_item_code', v_itemcode);
    v_loc     := nullif(el->>'location_id','')::uuid;
    v_batch   := coalesce(el->>'batch_no','');
    v_bags    := (el->>'bags')::numeric;
    v_kg      := (el->>'kg')::numeric;
    v_kgpb    := nullif(el->>'kg_per_bag','')::numeric;
    v_uom     := el->>'uom';
    v_ovr     := nullif(el->>'override_note','');
    if v_bags is null or v_bags <= 0 or v_kg is null or v_kg <= 0 then continue; end if;

    -- Take the bags out of the chosen WMS bin/batch.
    select * into v_src from wms_stock
      where item_code = v_srccode and location_id = v_loc and batch_no = v_batch
      order by warehouse_code limit 1;
    if not found then raise exception 'No warehouse stock of % in that bin/batch', v_srccode; end if;
    if v_src.quantity < v_bags then
      raise exception 'Only % % of % left in that bin — cannot take %', v_src.quantity, coalesce(v_src.uom,'unit'), v_srccode, v_bags;
    end if;
    v_desc := coalesce(el->>'description', v_src.description);

    update wms_stock set quantity = quantity - v_bags, updated_at = now() where id = v_src.id;
    delete from wms_stock where id = v_src.id and quantity <= 0;

    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values (v_src.warehouse_code, 'transfer', v_src.item_id, v_srccode, v_desc,
      v_src.location_id, v_src.location_code, v_batch, v_src.exp_date, v_bags,
      v_no || ' → production' || case when v_ovr is not null then ' (override: ' || v_ovr || ')' else '' end,
      auth.uid(), v_name);

    -- Book the equal kg into the factory (production) ledger.
    insert into stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date,
      qty_received, qty_remaining, request_item_id, do_number)
    values (v_itemid, v_itemcode, v_desc, v_req.factory_code, nullif(v_batch,''), v_src.exp_date,
      v_kg, v_kg, v_ri, v_no);

    insert into item_stock (item_id, factory_code, quantity, updated_at)
    values (v_itemid, v_req.factory_code, v_kg, now())
    on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + v_kg, updated_at = now();

    -- Auto-fill the Material Request line (kg is the loose unit).
    if v_ri is not null then
      update material_request_items set received_qty = coalesce(received_qty,0) + v_kg where id = v_ri;
    end if;

    insert into public.wms_production_transfer_lines (transfer_id, request_item_id, item_id, item_code,
      description, source_item_code, location_id, location_code, batch_no, exp_date, bags, uom, kg_per_bag, kg, override_note)
    values (v_tid, v_ri, v_itemid, v_itemcode, v_desc, v_srccode, v_loc, v_src.location_code,
      nullif(v_batch,''), v_src.exp_date, v_bags, v_uom, v_kgpb, v_kg, v_ovr);

    v_lines := v_lines + 1; v_totkg := v_totkg + v_kg;
  end loop;

  -- Recompute request status from its lines (same rule as goods-received).
  update material_requests m set status = case
      when (select bool_and(coalesce(received_qty,0) >= requested_qty) from material_request_items where request_id = m.id) then 'Fulfilled'
      when (select bool_or(coalesce(received_qty,0) > 0) from material_request_items where request_id = m.id) then 'Partially Received'
      else 'Open' end
    where m.id = p_request_id;

  -- Tell the factory their materials are in stock now.
  insert into public.notifications (factory_code, type, title, body, link, ref)
  values (v_req.factory_code, 'info', 'Materials transferred from warehouse',
    coalesce(v_name,'Warehouse') || ' sent ' || v_totkg || ' kg (' || v_lines || ' line(s)) to production — ' || v_no,
    '/production', 'pt:' || v_tid::text)
  on conflict (ref) do nothing;

  return jsonb_build_object('transfer_no', v_no, 'lines', v_lines, 'kg', v_totkg);
end $$;
grant execute on function public.wms_transfer_to_production(uuid, jsonb) to authenticated, anon, service_role;

-- 5. Hard lock: keep Production-only stock out of customer pick & reservation ----
-- Redefines wms_pick_from_bin (adds the production_only guard) and wms_reserve_order
-- (skips production_only rows in FEFO). Bodies are otherwise identical to
-- db/2026-07-14-wms-dispatch-reservations.sql.
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
        and coalesce(s.production_only,false) = false
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
