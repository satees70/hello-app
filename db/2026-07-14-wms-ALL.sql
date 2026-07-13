-- ============================================================
-- EASWARI WMS — FULL SETUP (run once in the Supabase SQL editor)
-- Safe to re-run. Runs all WMS migrations in dependency order.
-- ============================================================


-- ############################################################
-- wms-location-map.sql
-- ############################################################

-- WMS Module 1: Warehouse Location Map
-- Run this by hand in the Supabase SQL editor (it does NOT deploy with the code).
-- Safe to re-run. Adds ONE new table (wms_locations) and makes 'warehouse' a
-- restricted permission section. Touches NO existing table.

-- 1) Make 'warehouse' a restricted permission (hidden unless granted), like grinding/import.
--    Only the module list inside changes vs the current has_perm().
create or replace function public.has_perm(p_module text, p_action text)
returns boolean language sql stable security definer set search_path = public as $$
  with me as (select role, permissions from profiles where id = auth.uid())
  select case
    when (select role from me) = 'admin' then true
    when (select permissions from me) is null or (select permissions from me) = '{}'::jsonb
      then p_module not in ('grinding', 'grinding_recipe', 'import', 'warehouse')
    else coalesce((((select permissions from me) -> p_module) ->> p_action)::boolean, false)
  end
$$;
grant execute on function public.has_perm(text, text) to authenticated, anon, service_role;

-- 2) One row per storage location (bin), mirroring the SQL Account location list.
create table if not exists public.wms_locations (
  id             uuid primary key default gen_random_uuid(),
  warehouse_code text not null default '8BT',   -- the '8BT' segment of the SQL Account path
  category       text not null default 'Stock', -- the 'Stock' segment of the path
  location_type  text not null default 'SL',    -- 'SL' = pick face, 'XS' = excess / reserve
  code           text not null,                 -- the bin code, e.g. 'A105'
  aisle          text,                          -- leading letters ('A','AA') for grouping/sorting
  sql_location   text,                          -- exact SQL Account path: '8BT/Stock/SL/A105'
  label          text,
  pick_sequence  int,                           -- walking order for directed picking (set later)
  active         boolean not null default true,
  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- Ensure every column exists even if an older/empty wms_locations table was created
-- before this version (create table if not exists would skip it otherwise).
alter table public.wms_locations add column if not exists warehouse_code text not null default '8BT';
alter table public.wms_locations add column if not exists category      text not null default 'Stock';
alter table public.wms_locations add column if not exists location_type text not null default 'SL';
alter table public.wms_locations add column if not exists code          text;
alter table public.wms_locations add column if not exists aisle         text;
alter table public.wms_locations add column if not exists sql_location  text;
alter table public.wms_locations add column if not exists label         text;
alter table public.wms_locations add column if not exists pick_sequence int;
alter table public.wms_locations add column if not exists active        boolean not null default true;
alter table public.wms_locations add column if not exists notes         text;
alter table public.wms_locations add column if not exists created_by    uuid;
alter table public.wms_locations add column if not exists created_at    timestamptz not null default now();
alter table public.wms_locations add column if not exists updated_at    timestamptz not null default now();

-- The SQL Account path is the true unique identity of a location (the future join key
-- for orders-in / results-out with SQL Accounting). A bin code is unique per warehouse.
create unique index if not exists wms_locations_sqlpath_uniq on public.wms_locations(sql_location);
create unique index if not exists wms_locations_code_uniq   on public.wms_locations(warehouse_code, code);
create index if not exists wms_locations_type  on public.wms_locations(location_type);
create index if not exists wms_locations_aisle on public.wms_locations(aisle);

-- 3) Grants + row security (same pattern as the app's other tables).
grant select, insert, update, delete on public.wms_locations to authenticated, anon, service_role;
alter table public.wms_locations enable row level security;

drop policy if exists wms_loc_read on public.wms_locations;
create policy wms_loc_read on public.wms_locations for select
  using (has_perm('warehouse','view'));
drop policy if exists wms_loc_write on public.wms_locations;
create policy wms_loc_write on public.wms_locations for all
  using (has_perm('warehouse','edit'))
  with check (has_perm('warehouse','edit'));

-- Refresh the PostgREST schema cache so the API sees all columns immediately
-- (prevents "Could not find the 'aisle' column ... in the schema cache" on import).
notify pgrst, 'reload schema';


-- ############################################################
-- wms-stock.sql
-- ############################################################

-- WMS Module 2: warehouse bin-level stock (batch + expiry) for the 8BT warehouse.
-- Run in the Supabase SQL editor. The ONE shared stock truth. Idempotent.
create table if not exists public.wms_stock (
  id            uuid primary key default gen_random_uuid(),
  warehouse_code text not null default '8BT',
  item_id       uuid references public.items(id),
  item_code     text not null,
  description   text,
  location_id   uuid not null references public.wms_locations(id) on delete restrict,
  location_code text not null,
  batch_no      text not null default '',
  exp_date      date,
  quantity      numeric not null default 0,
  uom           text,
  notes         text,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create unique index if not exists wms_stock_uniq on public.wms_stock(warehouse_code, item_code, location_id, batch_no);
create index if not exists wms_stock_item on public.wms_stock(item_id, exp_date nulls last);
create index if not exists wms_stock_loc  on public.wms_stock(location_id);

grant select, insert, update, delete on public.wms_stock to authenticated, anon, service_role;
alter table public.wms_stock enable row level security;
drop policy if exists wms_stock_read on public.wms_stock;
create policy wms_stock_read on public.wms_stock for select using (has_perm('warehouse','view'));
drop policy if exists wms_stock_write on public.wms_stock;
create policy wms_stock_write on public.wms_stock for all using (has_perm('warehouse','edit')) with check (has_perm('warehouse','edit'));

notify pgrst, 'reload schema';


-- ############################################################
-- wms-movements-putaway.sql
-- ############################################################

-- WMS Module 3a: movement ledger + directed putaway (and a logged stock-adjust).
-- Run in the Supabase SQL editor. Adds ONE table (wms_stock_moves) + 2 functions.
-- Every warehouse stock change flows through a function that also records a move —
-- the audit trail and the future "results out" channel to SQL Account.

-- 1) The movement log. Direction is implied by from/to: putaway has only a "to" bin,
--    a pick has only a "from" bin, a transfer has both.
create table if not exists public.wms_stock_moves (
  id                 uuid primary key default gen_random_uuid(),
  warehouse_code     text not null default '8BT',
  move_type          text not null,   -- 'putaway' | 'pick' | 'adjust' | 'transfer'
  item_id            uuid references public.items(id),
  item_code          text not null,
  description        text,
  from_location_id   uuid references public.wms_locations(id),
  from_location_code text,
  to_location_id     uuid references public.wms_locations(id),
  to_location_code   text,
  batch_no           text not null default '',
  exp_date           date,
  quantity           numeric not null,     -- always positive
  reference          text,                 -- GRN / order no / reason
  moved_by           uuid,
  moved_by_name      text,
  created_at         timestamptz not null default now()
);
create index if not exists wms_moves_item on public.wms_stock_moves(item_id, created_at desc);
create index if not exists wms_moves_when on public.wms_stock_moves(created_at desc);
create index if not exists wms_moves_type on public.wms_stock_moves(move_type);

grant select, insert, update, delete on public.wms_stock_moves to authenticated, anon, service_role;
alter table public.wms_stock_moves enable row level security;
drop policy if exists wms_moves_read on public.wms_stock_moves;
create policy wms_moves_read on public.wms_stock_moves for select using (has_perm('warehouse','view'));
drop policy if exists wms_moves_write on public.wms_stock_moves;
create policy wms_moves_write on public.wms_stock_moves for all using (has_perm('warehouse','edit')) with check (has_perm('warehouse','edit'));

-- 2) Directed putaway: ADD p_qty of an item into a bin (consolidates with existing
--    stock of the same item+batch in that bin) and log a 'putaway' move.
create or replace function public.wms_putaway(
  p_item_code text, p_location_id uuid, p_qty numeric,
  p_batch text default '', p_exp_date date default null, p_reference text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item_id uuid; v_desc text; v_uom text; v_loc_code text; v_name text;
  v_batch text := coalesce(p_batch, '');
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to move warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  select id, description, unit into v_item_id, v_desc, v_uom from items where code = p_item_code;
  select code into v_loc_code from wms_locations where id = p_location_id;
  if v_loc_code is null then raise exception 'That bin is not in the Location Map'; end if;
  select full_name into v_name from profiles where id = auth.uid();

  insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', v_item_id, p_item_code, v_desc, p_location_id, v_loc_code, v_batch, p_exp_date, p_qty, v_uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
  do update set quantity = wms_stock.quantity + excluded.quantity,
                exp_date = coalesce(excluded.exp_date, wms_stock.exp_date),
                updated_at = now();

  insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'putaway', v_item_id, p_item_code, v_desc,
    p_location_id, v_loc_code, v_batch, p_exp_date, p_qty, p_reference, auth.uid(), v_name);
end $$;
grant execute on function public.wms_putaway(text, uuid, numeric, text, date, text) to authenticated, anon, service_role;

-- 3) Logged adjust/correction: SET the on-hand of an item+batch in a bin to an exact
--    number (0 = remove) and log an 'adjust' move for the difference.
create or replace function public.wms_adjust_stock(
  p_item_code text, p_location_id uuid, p_batch text, p_exp_date date, p_new_qty numeric, p_reference text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item_id uuid; v_desc text; v_uom text; v_loc_code text; v_name text;
  v_batch text := coalesce(p_batch, ''); v_old numeric; v_delta numeric;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to move warehouse stock'; end if;
  if p_new_qty is null or p_new_qty < 0 then raise exception 'Quantity cannot be negative'; end if;
  select id, description, unit into v_item_id, v_desc, v_uom from items where code = p_item_code;
  select code into v_loc_code from wms_locations where id = p_location_id;
  if v_loc_code is null then raise exception 'That bin is not in the Location Map'; end if;
  select quantity into v_old from wms_stock
    where warehouse_code = '8BT' and item_code = p_item_code and location_id = p_location_id and batch_no = v_batch;
  v_old := coalesce(v_old, 0);
  v_delta := p_new_qty - v_old;
  select full_name into v_name from profiles where id = auth.uid();

  if p_new_qty = 0 then
    delete from wms_stock
      where warehouse_code = '8BT' and item_code = p_item_code and location_id = p_location_id and batch_no = v_batch;
  else
    insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values ('8BT', v_item_id, p_item_code, v_desc, p_location_id, v_loc_code, v_batch, p_exp_date, p_new_qty, v_uom)
    on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = excluded.quantity, exp_date = excluded.exp_date, description = excluded.description, updated_at = now();
  end if;

  if v_delta <> 0 then
    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'adjust', v_item_id, p_item_code, v_desc,
      case when v_delta < 0 then p_location_id end, case when v_delta < 0 then v_loc_code end,
      case when v_delta > 0 then p_location_id end, case when v_delta > 0 then v_loc_code end,
      v_batch, p_exp_date, abs(v_delta), p_reference, auth.uid(), v_name);
  end if;
end $$;
grant execute on function public.wms_adjust_stock(text, uuid, text, date, numeric, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';


-- ############################################################
-- wms-orders.sql
-- ############################################################

-- WMS Module 3b (part 1): warehouse "orders in" — the single entry point for
-- orders the warehouse must pick. Today they arrive as uploaded PDFs read by the
-- Anthropic API (same pattern as extract-sales-order); later the SQL Account API
-- can fill these SAME tables (wms_orders.source flags where a row came from), so
-- the pick screens never need to know the source.
--
-- Run in the Supabase SQL editor. Adds a private bucket + 2 tables. Idempotent.

-- 1) Private bucket for the uploaded order PDFs.
insert into storage.buckets (id, name, public)
values ('wms-orders', 'wms-orders', false)
on conflict (id) do nothing;

drop policy if exists wms_orders_file_read   on storage.objects;
drop policy if exists wms_orders_file_write  on storage.objects;
drop policy if exists wms_orders_file_delete on storage.objects;
create policy wms_orders_file_read   on storage.objects for select to authenticated
  using (bucket_id = 'wms-orders' and has_perm('warehouse', 'view'));
create policy wms_orders_file_write  on storage.objects for insert to authenticated
  with check (bucket_id = 'wms-orders' and has_perm('warehouse', 'edit'));
create policy wms_orders_file_delete on storage.objects for delete to authenticated
  using (bucket_id = 'wms-orders' and has_perm('warehouse', 'edit'));

-- 2) Order header — one per uploaded document / incoming order.
create table if not exists public.wms_orders (
  id               uuid primary key default gen_random_uuid(),
  warehouse_code   text not null default '8BT',
  source           text not null default 'pdf' check (source in ('pdf', 'sql_account', 'manual')),
  order_no         text,
  customer_name    text,
  order_date       text,                       -- kept as printed; parsing not required
  file_name        text,
  file_path        text,                       -- path inside the wms-orders bucket
  status           text not null default 'Processing'
    check (status in ('Processing', 'Review', 'Released', 'Picking', 'Picked', 'Error', 'Cancelled')),
  error_message    text,
  uploaded_by      uuid,
  uploaded_by_name text,
  created_at       timestamptz not null default now()
);
create index if not exists wms_orders_status on public.wms_orders(status, created_at desc);

-- 3) Order lines — what to pick.
create table if not exists public.wms_order_lines (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.wms_orders(id) on delete cascade,
  line_no     int,
  item_id     uuid references public.items(id),
  item_code   text not null,
  description text,
  quantity    numeric not null default 0,      -- ordered quantity
  qty_picked  numeric not null default 0,      -- filled in during picking (Module 3b part 2)
  uom         text,
  created_at  timestamptz not null default now()
);
create index if not exists wms_order_lines_order on public.wms_order_lines(order_id);

-- 4) Grants + RLS (warehouse permission).
grant select, insert, update, delete on public.wms_orders      to authenticated, anon, service_role;
grant select, insert, update, delete on public.wms_order_lines to authenticated, anon, service_role;
alter table public.wms_orders      enable row level security;
alter table public.wms_order_lines enable row level security;

drop policy if exists wms_orders_read  on public.wms_orders;
drop policy if exists wms_orders_write on public.wms_orders;
create policy wms_orders_read  on public.wms_orders for select using (has_perm('warehouse', 'view'));
create policy wms_orders_write on public.wms_orders for all using (has_perm('warehouse', 'edit')) with check (has_perm('warehouse', 'edit'));

drop policy if exists wms_order_lines_read  on public.wms_order_lines;
drop policy if exists wms_order_lines_write on public.wms_order_lines;
create policy wms_order_lines_read  on public.wms_order_lines for select using (has_perm('warehouse', 'view'));
create policy wms_order_lines_write on public.wms_order_lines for all using (has_perm('warehouse', 'edit')) with check (has_perm('warehouse', 'edit'));

-- 5) Extra fields captured from the SQL Account "PICKING LIST" layout.
--    delivery_date on the header; per-line the SQL Account "Picked Location" hint
--    (SUPPLIER / a factory / a bin) and the Remarks (batch or expiry note).
alter table public.wms_orders      add column if not exists delivery_date text;
alter table public.wms_order_lines add column if not exists source_hint text;
alter table public.wms_order_lines add column if not exists remarks     text;

notify pgrst, 'reload schema';


-- ############################################################
-- wms-picking.sql
-- ############################################################

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

-- Pick from a SPECIFIC bin + batch the picker chooses (replaces the manual
-- bin/batch selection they used to write on the SQL Account picking list).
-- Caps at what the bin actually holds; logs a 'pick' move; updates the order.
create or replace function public.wms_pick_from_bin(
  p_line_id uuid, p_location_id uuid, p_batch text, p_qty numeric, p_reference text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line  wms_order_lines;
  v_order wms_orders;
  v_stock wms_stock;
  v_name  text;
  v_batch text := coalesce(p_batch, '');
  v_take  numeric;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to pick warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Pick quantity must be greater than zero'; end if;

  select * into v_line from wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from wms_orders where id = v_line.order_id;
  select full_name into v_name from profiles where id = auth.uid();

  select * into v_stock from wms_stock
    where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = p_location_id and batch_no = v_batch;
  if not found or v_stock.quantity <= 0 then raise exception 'No stock of % in that bin/batch', v_line.item_code; end if;

  v_take := least(v_stock.quantity, p_qty);   -- can't take more than the bin holds

  update wms_stock set quantity = quantity - v_take, updated_at = now() where id = v_stock.id;
  delete from wms_stock where id = v_stock.id and quantity <= 0;

  insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'pick', v_line.item_id, v_line.item_code, v_line.description,
    v_stock.location_id, v_stock.location_code, v_stock.batch_no, v_stock.exp_date, v_take,
    coalesce(p_reference, v_order.order_no), auth.uid(), v_name);

  update wms_order_lines set qty_picked = qty_picked + v_take where id = p_line_id;

  update wms_orders o set status = case
      when not exists (select 1 from wms_order_lines wl where wl.order_id = o.id and wl.qty_picked < wl.quantity) then 'Picked'
      when exists (select 1 from wms_order_lines wl where wl.order_id = o.id and wl.qty_picked > 0) then 'Picking'
      else o.status end
    where o.id = v_line.order_id;

  return jsonb_build_object('picked', v_take, 'requested', p_qty);
end $$;
grant execute on function public.wms_pick_from_bin(uuid, uuid, text, numeric, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';


-- ############################################################
-- wms-transfer.sql
-- ############################################################

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


-- ############################################################
-- wms-purchasing.sql
-- ############################################################

-- ============================================================
-- WMS: Supplier Purchase Orders + Goods Received (GRN)
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- Builds on the EXISTING wms_stock / wms_stock_moves — no new stock store.
-- ============================================================

-- Private bucket for PO PDFs + goods-in photos.
insert into storage.buckets (id, name, public) values ('wms-grn','wms-grn',false) on conflict (id) do nothing;
drop policy if exists wms_grn_read on storage.objects;
drop policy if exists wms_grn_write on storage.objects;
drop policy if exists wms_grn_del on storage.objects;
create policy wms_grn_read  on storage.objects for select to authenticated using (bucket_id='wms-grn' and has_perm('warehouse','view'));
create policy wms_grn_write on storage.objects for insert to authenticated with check (bucket_id='wms-grn' and has_perm('warehouse','edit'));
create policy wms_grn_del   on storage.objects for delete to authenticated using (bucket_id='wms-grn' and has_perm('warehouse','edit'));

-- Purchase order header + lines.
create table if not exists public.wms_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  warehouse_code text not null default '8BT',
  source text not null default 'pdf' check (source in ('pdf','sql_account','manual')),
  po_number text, supplier_name text, order_date text, expected_date text,
  file_name text, file_path text,
  status text not null default 'Processing'
    check (status in ('Processing','Open','Partially Received','Fulfilled','Cancelled','Error')),
  error_message text, created_by uuid, created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists wms_po_status on public.wms_purchase_orders(status, created_at desc);

create table if not exists public.wms_po_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.wms_purchase_orders(id) on delete cascade,
  line_no int, item_id uuid references public.items(id),
  item_code text not null, description text,
  quantity numeric not null default 0, qty_received numeric not null default 0, uom text,
  created_at timestamptz not null default now()
);
create index if not exists wms_po_lines_po on public.wms_po_lines(po_id);

-- Goods Received Note (one per delivery received against a PO) + its lines.
create sequence if not exists wms_grn_seq;
create table if not exists public.wms_grns (
  id uuid primary key default gen_random_uuid(),
  warehouse_code text not null default '8BT',
  grn_no text, po_id uuid references public.wms_purchase_orders(id) on delete set null,
  supplier_name text, received_at timestamptz not null default now(),
  received_by uuid, received_by_name text, notes text,
  created_at timestamptz not null default now()
);
create table if not exists public.wms_grn_lines (
  id uuid primary key default gen_random_uuid(),
  grn_id uuid not null references public.wms_grns(id) on delete cascade,
  po_line_id uuid references public.wms_po_lines(id) on delete set null,
  item_id uuid references public.items(id),
  item_code text not null, description text,
  qty_received numeric not null default 0, batch_no text not null default '', exp_date date,
  qc_status text not null default 'pass' check (qc_status in ('pass','fail')),
  qc_note text, photo_path text,
  created_at timestamptz not null default now()
);
create index if not exists wms_grn_lines_grn on public.wms_grn_lines(grn_id);

-- The GOODS-IN staging bin: received stock lands here = "pending putaway".
insert into public.wms_locations (warehouse_code, category, location_type, code, aisle, sql_location, label, active)
values ('8BT','Stock','STAGE','GOODS-IN','GOODS-IN','8BT/Stock/STAGE/GOODS-IN','Goods-in / pending putaway', true)
on conflict (warehouse_code, code) do nothing;

-- Grants + RLS for the four tables.
grant select, insert, update, delete on
  public.wms_purchase_orders, public.wms_po_lines, public.wms_grns, public.wms_grn_lines
  to authenticated, anon, service_role;
grant usage on sequence wms_grn_seq to authenticated, anon, service_role;
do $$
declare t text;
begin
  foreach t in array array['wms_purchase_orders','wms_po_lines','wms_grns','wms_grn_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (has_perm(''warehouse'',''view''))', t, t);
    execute format('create policy %I_write on public.%I for all using (has_perm(''warehouse'',''edit'')) with check (has_perm(''warehouse'',''edit''))', t, t);
  end loop;
end $$;

-- Start a Goods Received Note against a PO (assigns a GRN number). Returns its id.
create or replace function public.wms_start_grn(p_po_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_supplier text; v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to receive goods'; end if;
  select supplier_name into v_supplier from wms_purchase_orders where id = p_po_id;
  select full_name into v_name from profiles where id = auth.uid();
  insert into wms_grns (grn_no, po_id, supplier_name, received_by, received_by_name)
  values ('GRN-' || lpad(nextval('wms_grn_seq')::text, 6, '0'), p_po_id, v_supplier, auth.uid(), v_name)
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.wms_start_grn(uuid) to authenticated, anon, service_role;

-- Receive one delivered line: record it, book the stock into the GOODS-IN staging
-- bin (the ONE shared stock truth), log a 'receipt' move, reduce the PO outstanding,
-- and update the PO status (Open → Partially Received → Fulfilled).
create or replace function public.wms_receive_line(
  p_grn_id uuid, p_po_line_id uuid, p_item_code text, p_qty numeric,
  p_batch text, p_exp_date date, p_qc text, p_qc_note text, p_photo_path text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item_id uuid; v_desc text; v_uom text; v_stage uuid; v_name text; v_po_id uuid;
  v_batch text := coalesce(p_batch,'');
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to receive goods'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  select id, description, unit into v_item_id, v_desc, v_uom from items where code = p_item_code;
  select id into v_stage from wms_locations where warehouse_code='8BT' and code='GOODS-IN';
  if v_stage is null then raise exception 'GOODS-IN staging bin is missing — run the WMS purchasing migration'; end if;
  select full_name into v_name from profiles where id = auth.uid();

  insert into wms_grn_lines (grn_id, po_line_id, item_id, item_code, description, qty_received, batch_no, exp_date, qc_status, qc_note, photo_path)
  values (p_grn_id, p_po_line_id, v_item_id, p_item_code, v_desc, p_qty, v_batch, p_exp_date, coalesce(p_qc,'pass'), p_qc_note, p_photo_path);

  -- add to the ONE stock table, at GOODS-IN
  insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', v_item_id, p_item_code, v_desc, v_stage, 'GOODS-IN', v_batch, p_exp_date, p_qty, v_uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
  do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();

  insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'receipt', v_item_id, p_item_code, v_desc, v_stage, 'GOODS-IN', v_batch, p_exp_date, p_qty,
    (select grn_no from wms_grns where id = p_grn_id), auth.uid(), v_name);

  if p_po_line_id is not null then
    update wms_po_lines set qty_received = qty_received + p_qty where id = p_po_line_id;
    select po_id into v_po_id from wms_po_lines where id = p_po_line_id;
  else
    select po_id into v_po_id from wms_grns where id = p_grn_id;
  end if;

  if v_po_id is not null then
    update wms_purchase_orders o set status = case
        when o.status = 'Cancelled' then o.status
        when not exists (select 1 from wms_po_lines pl where pl.po_id = o.id and pl.qty_received < pl.quantity) then 'Fulfilled'
        when exists (select 1 from wms_po_lines pl where pl.po_id = o.id and pl.qty_received > 0) then 'Partially Received'
        else 'Open' end
      where o.id = v_po_id;
  end if;
end $$;
grant execute on function public.wms_receive_line(uuid, uuid, text, numeric, text, date, text, text, text) to authenticated, anon, service_role;

-- Picking must NOT pull from the GOODS-IN staging bin (not on a shelf yet).
-- Re-defines wms_pick_line to exclude location_type 'STAGE'.
create or replace function public.wms_pick_line(p_line_id uuid, p_qty numeric, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line wms_order_lines; v_order wms_orders; v_name text;
  v_need numeric; v_picked numeric := 0; v_take numeric; v_allocs jsonb := '[]'::jsonb; r record;
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
    from wms_stock s join wms_locations l on l.id = s.location_id
    where s.warehouse_code = '8BT' and s.item_code = v_line.item_code and s.quantity > 0
      and l.location_type <> 'STAGE'
    order by (l.location_type <> 'SL'), s.exp_date asc nulls last, coalesce(l.pick_sequence, 999999), s.location_code
  loop
    exit when v_need <= 0;
    v_take := least(r.quantity, v_need);
    update wms_stock set quantity = quantity - v_take, updated_at = now() where id = r.id;
    delete from wms_stock where id = r.id and quantity <= 0;
    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'pick', v_line.item_id, v_line.item_code, v_line.description,
      r.location_id, r.location_code, r.batch_no, r.exp_date, v_take, coalesce(p_reference, v_order.order_no), auth.uid(), v_name);
    v_allocs := v_allocs || jsonb_build_object('bin', r.location_code, 'batch', r.batch_no, 'exp', r.exp_date, 'qty', v_take);
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

