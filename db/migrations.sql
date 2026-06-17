-- ============================================================================
-- AVINA Portal — database changes log
-- ----------------------------------------------------------------------------
-- A running record of the schema changes (columns, tables, functions) applied
-- in Supabase, so they're tracked in the repo instead of scattered "Untitled
-- query" snippets. Newest sections at the bottom. Everything here is already
-- applied to the live database — this file is the documented record, and lets
-- you recreate the current state on a fresh database if ever needed.
--
-- Add a new section here whenever a DB change is made.
-- ============================================================================


-- ============================================================================
-- 2026-06 · Pick-run release & cut-off (Material Requests → Combined picking)
-- ============================================================================

-- Requests wait until "released" to the warehouse as a fixed, numbered pick run.
alter table material_requests add column if not exists released_at timestamptz;
alter table material_requests add column if not exists pick_run_no text;
create sequence if not exists pick_run_seq;  -- legacy global counter, now unused

-- Release a factory's waiting requests as ONE pick run, numbered PER LOCATION,
-- PER MONTH: PR<digits of factory>-<YYMM>/<NNNN> (e.g. PR101-2606/0001). The
-- running number resets each month. Uses Malaysia time so the month flips local.
create or replace function public.release_pick_run(p_factory text)
returns text language plpgsql security definer set search_path = public as $$
declare v_no text; v_seq int; v_fac text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' and my_factory_code() <> p_factory then
    raise exception 'Not allowed to release for this factory';
  end if;
  if not exists (select 1 from material_requests where factory_code = p_factory and released_at is null) then
    raise exception 'Nothing waiting to release';
  end if;
  v_fac := coalesce(nullif(regexp_replace(p_factory, '[^0-9]', '', 'g'), ''), p_factory);
  select coalesce(max((split_part(pick_run_no, '/', 2))::int), 0) + 1 into v_seq
    from material_requests
   where factory_code = p_factory
     and pick_run_no like 'PR' || v_fac || '-' || to_char((now() at time zone 'Asia/Kuala_Lumpur'), 'YYMM') || '/%';
  v_no := 'PR' || v_fac || '-' || to_char((now() at time zone 'Asia/Kuala_Lumpur'), 'YYMM') || '/' || lpad(v_seq::text, 4, '0');
  update material_requests set released_at = now(), pick_run_no = v_no
   where factory_code = p_factory and released_at is null;
  return v_no;
end $$;
grant execute on function public.release_pick_run(text) to authenticated;


-- ============================================================================
-- 2026-06 · Factory-supplied items (labels) & product expiry date
-- ============================================================================

-- Items made/supplied by the factory itself (e.g. printed labels) route to a
-- separate "factory" list instead of the warehouse pick list.
alter table items add column if not exists supplied_by_factory boolean not null default false;

-- Product (packing) expiry date — entered at production, printed on labels.
-- Raw materials never carry an expiry; only the packed product does.
alter table production_batches add column if not exists exp_date date;


-- ============================================================================
-- 2026-06 · Delivery Order bag/carton → KG conversion
-- ============================================================================

-- Optional per-item override for "KG per bag/carton" when the item code doesn't
-- show the pack size (e.g. a typo). Normally read from the code (e.g. 3KG/BAG).
alter table items add column if not exists kg_per_bag numeric;


-- ============================================================================
-- 2026-06 · Receiving moves stock, with batch + expiry lot tracking (FEFO)
-- ============================================================================

-- Each received delivery is recorded as a lot, kept separately for first-expiry-
-- first-out. qty_remaining is for future consumption (not yet decremented).
create table if not exists public.stock_lots (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id),
  item_code text not null,
  description text,
  factory_code text not null,
  batch_no text,
  exp_date date,
  qty_received numeric not null,
  qty_remaining numeric not null,
  request_item_id uuid references public.material_request_items(id) on delete set null,
  unplanned boolean not null default false,   -- received without a matching order
  do_number text,                             -- source Delivery Order number
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists stock_lots_fefo on public.stock_lots (item_id, factory_code, exp_date nulls last);

grant select, insert, update, delete on public.stock_lots to authenticated, anon, service_role;
alter table public.stock_lots enable row level security;

drop policy if exists stock_lots_read on public.stock_lots;
create policy stock_lots_read on public.stock_lots for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = my_factory_code());
drop policy if exists stock_lots_write on public.stock_lots;
create policy stock_lots_write on public.stock_lots for all
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = my_factory_code())
  with check (my_factory_code() = 'HEAD_OFFICE' or factory_code = my_factory_code());

-- IMPORTANT ORDER in the receive functions: update the request line + status
-- BEFORE bumping item_stock. Bumping item_stock fires the auto-refresh trigger,
-- which rebuilds OPEN requests' lines (wiping received_qty); moving the request
-- out of 'Open' first makes that trigger skip it.

-- Receive a delivery against ONE request line.
create or replace function public.receive_material_lot(p_item_id uuid, p_qty numeric, p_batch_no text, p_exp_date date, p_do_number text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_it public.material_request_items; v_req public.material_requests;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  select * into v_it from public.material_request_items where id = p_item_id;
  if not found then raise exception 'Request line not found'; end if;
  select * into v_req from public.material_requests where id = v_it.request_id;
  if my_factory_code() <> 'HEAD_OFFICE' and v_req.factory_code <> my_factory_code() then raise exception 'Not allowed for this factory'; end if;
  insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining, request_item_id, do_number)
  values (v_it.item_id, v_it.item_code, v_it.description, v_req.factory_code, nullif(p_batch_no,''), p_exp_date, p_qty, p_qty, p_item_id, nullif(p_do_number,''));
  update public.material_request_items set received_qty = received_qty + p_qty where id = p_item_id;
  update public.material_requests set status =
    case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = v_req.id) then 'Fulfilled'
         when (select bool_or(received_qty > 0) from public.material_request_items where request_id = v_req.id) then 'Partially Received'
         else 'Open' end
  where id = v_req.id;
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (v_it.item_id, v_req.factory_code, p_qty, now())
  on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + p_qty, updated_at = now();
end $$;
grant execute on function public.receive_material_lot(uuid, numeric, text, date, text) to authenticated;

-- Receive a COMBINED warehouse delivery: one physical lot, split across the
-- lines (oldest first); leftover/over-delivery goes onto the last line.
create or replace function public.receive_combined_lot(p_item_ids uuid[], p_qty numeric, p_batch_no text, p_exp_date date, p_do_number text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_first public.material_request_items; v_factory text; v_remaining numeric := p_qty; v_alloc numeric; c record; v_reqid uuid;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  if array_length(p_item_ids,1) is null then raise exception 'No request lines given'; end if;
  select * into v_first from public.material_request_items where id = p_item_ids[1];
  select factory_code into v_factory from public.material_requests where id = v_first.request_id;
  if my_factory_code() <> 'HEAD_OFFICE' and v_factory <> my_factory_code() then raise exception 'Not allowed for this factory'; end if;
  insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining, do_number)
  values (v_first.item_id, v_first.item_code, v_first.description, v_factory, nullif(p_batch_no,''), p_exp_date, p_qty, p_qty, nullif(p_do_number,''));
  for c in select mri.id, mri.requested_qty, mri.received_qty from public.material_request_items mri join public.material_requests mr on mr.id = mri.request_id where mri.id = any(p_item_ids) order by mr.created_at asc, mri.id asc
  loop
    exit when v_remaining <= 0;
    v_alloc := least(v_remaining, greatest(c.requested_qty - c.received_qty, 0));
    if v_alloc > 0 then update public.material_request_items set received_qty = received_qty + v_alloc where id = c.id; v_remaining := v_remaining - v_alloc; end if;
  end loop;
  if v_remaining > 0 then update public.material_request_items set received_qty = received_qty + v_remaining where id = p_item_ids[array_length(p_item_ids,1)]; end if;
  for v_reqid in select distinct request_id from public.material_request_items where id = any(p_item_ids) loop
    update public.material_requests set status =
      case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = v_reqid) then 'Fulfilled'
           when (select bool_or(received_qty > 0) from public.material_request_items where request_id = v_reqid) then 'Partially Received'
           else 'Open' end
    where id = v_reqid;
  end loop;
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (v_first.item_id, v_factory, p_qty, now())
  on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + p_qty, updated_at = now();
end $$;
grant execute on function public.receive_combined_lot(uuid[], numeric, text, date, text) to authenticated;

-- Receive a KNOWN item into stock with NO order (extra/unrequested delivery),
-- flagged unplanned. Unknown codes raise 'Unknown item' (frontend skips + warns).
create or replace function public.receive_stock_direct(p_item_code text, p_factory text, p_qty numeric, p_batch_no text, p_exp_date date, p_do_number text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_item public.items;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and p_factory <> my_factory_code() then raise exception 'Not allowed for this factory'; end if;
  select * into v_item from public.items where code = p_item_code limit 1;
  if not found then raise exception 'Unknown item %', p_item_code; end if;
  insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining, request_item_id, unplanned, do_number)
  values (v_item.id, v_item.code, v_item.description, p_factory, nullif(p_batch_no,''), p_exp_date, p_qty, p_qty, null, true, nullif(p_do_number,''));
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (v_item.id, p_factory, p_qty, now())
  on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + p_qty, updated_at = now();
end $$;
grant execute on function public.receive_stock_direct(text, text, numeric, text, date, text) to authenticated;


-- ============================================================================
-- 2026-06 · Delivery Orders as stored documents (like Sales Orders)
-- ============================================================================

-- PDF storage bucket for delivery orders + access for logged-in users.
insert into storage.buckets (id, name) values ('delivery-orders', 'delivery-orders') on conflict (id) do nothing;
drop policy if exists delivery_orders_obj_all on storage.objects;
create policy delivery_orders_obj_all on storage.objects for all to authenticated
  using (bucket_id = 'delivery-orders') with check (bucket_id = 'delivery-orders');

-- Document header (one row per uploaded DO).
create table if not exists public.delivery_orders (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_path text not null,
  do_number text,
  do_date text,
  factory_code text not null,
  status text not null default 'Processing',   -- Processing → Review → Received (or Error)
  uploaded_by uuid,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.delivery_orders to authenticated, anon, service_role;
alter table public.delivery_orders enable row level security;
drop policy if exists do_read on public.delivery_orders;
create policy do_read on public.delivery_orders for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = my_factory_code());
drop policy if exists do_write on public.delivery_orders;
create policy do_write on public.delivery_orders for all
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = my_factory_code())
  with check (my_factory_code() = 'HEAD_OFFICE' or factory_code = my_factory_code());

-- Extracted lines for each DO.
create table if not exists public.delivery_order_lines (
  id uuid primary key default gen_random_uuid(),
  do_id uuid not null references public.delivery_orders(id) on delete cascade,
  item_code text not null,
  description text,
  quantity numeric,
  unit text,
  batch_no text,
  created_at timestamptz not null default now()
);
create index if not exists delivery_order_lines_do on public.delivery_order_lines(do_id);
grant select, insert, update, delete on public.delivery_order_lines to authenticated, anon, service_role;
alter table public.delivery_order_lines enable row level security;
drop policy if exists dol_read on public.delivery_order_lines;
create policy dol_read on public.delivery_order_lines for select
  using (exists (select 1 from public.delivery_orders d where d.id = do_id and (my_factory_code() = 'HEAD_OFFICE' or d.factory_code = my_factory_code())));
drop policy if exists dol_write on public.delivery_order_lines;
create policy dol_write on public.delivery_order_lines for all
  using (exists (select 1 from public.delivery_orders d where d.id = do_id and (my_factory_code() = 'HEAD_OFFICE' or d.factory_code = my_factory_code())))
  with check (exists (select 1 from public.delivery_orders d where d.id = do_id and (my_factory_code() = 'HEAD_OFFICE' or d.factory_code = my_factory_code())));


-- ============================================================================
-- 2026-06 · Delivery Order: QC tick, per-line photo, partial receiving
-- ============================================================================
alter table delivery_order_lines add column if not exists qc_checked boolean not null default false;
alter table delivery_order_lines add column if not exists photo_path text;   -- one photo per line in the delivery-orders bucket
alter table delivery_order_lines add column if not exists received_at timestamptz; -- set when that line is received (partial receiving)


-- ============================================================================
-- 2026-06 · Production recording + raw-material consumption (FEFO)
-- ============================================================================
-- Record actual produced qty on a batch (balance vs planned = backorder), and
-- consume the BOM's raw materials from this factory's stock earliest-expiry /
-- oldest-received first, logging exactly which lots were consumed.
alter table public.production_batches add column if not exists produced_qty numeric not null default 0;

create table if not exists public.production_consumption (
  id uuid primary key default gen_random_uuid(),
  production_batch_id uuid not null references public.production_batches(id) on delete cascade,
  lot_id uuid references public.stock_lots(id) on delete set null,
  item_id uuid, item_code text, description text, batch_no text, exp_date date,
  factory_code text, qty_consumed numeric not null, run_qty numeric,
  consumed_at timestamptz not null default now()
);
create index if not exists production_consumption_batch on public.production_consumption(production_batch_id);
grant select, insert, update, delete on public.production_consumption to authenticated, anon, service_role;
alter table public.production_consumption enable row level security;
drop policy if exists pc_read on public.production_consumption;
create policy pc_read on public.production_consumption for select
  using (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code());
drop policy if exists pc_write on public.production_consumption;
create policy pc_write on public.production_consumption for all
  using (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code())
  with check (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code());

-- record_production(batch, qty): explode BOM, consume stock_lots FEFO (exp asc
-- nulls last, then received_at asc), decrement item_stock, log to
-- production_consumption, bump produced_qty, set status; returns jsonb
-- {consumed[], shortfalls[]}. (Full body in the SQL Editor snippet / git commit.)


-- ============================================================================
-- 2026-06 · Packing & Finished Good Inspection Record (P07-F01)
-- ============================================================================
-- Digital QC inspection form tied to a production batch; all fields stored as
-- jsonb (form a header/process/sealing/metal-detector/yield/sign-offs + form b
-- hourly log). UI: /inspection?batch=<id>, opened from a production batch.
create table if not exists public.inspection_records (
  id uuid primary key default gen_random_uuid(),
  production_batch_id uuid references public.production_batches(id) on delete set null,
  factory_code text not null,
  data jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inspection_records_batch on public.inspection_records(production_batch_id);
grant select, insert, update, delete on public.inspection_records to authenticated, anon, service_role;
alter table public.inspection_records enable row level security;
drop policy if exists ir_read on public.inspection_records;
create policy ir_read on public.inspection_records for select
  using (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code());
drop policy if exists ir_write on public.inspection_records;
create policy ir_write on public.inspection_records for all
  using (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code())
  with check (my_factory_code()='HEAD_OFFICE' or factory_code = my_factory_code());


-- ============================================================================
-- 2026-06 · Order Board pack planning (which line packs each order & when)
-- ============================================================================
alter table production_batches add column if not exists pack_line text;
alter table production_batches add column if not exists pack_date date;


-- ============================================================================
-- 2026-06 · Per-section user permissions (view / edit / delete)
-- ============================================================================
-- Each user gets a permission grid stored as jsonb on their profile, shaped
--   { "sales": {"view":true,"edit":true,"delete":false}, "production": {...}, ... }
-- Sections: sales, production, receiving, stock, items, bom, traceability, users.
-- SAFETY: an EMPTY object ({}) means "not configured yet" → legacy full access,
-- so existing users keep working until Head Office sets their grid. Admins always
-- have full access regardless. Enforcement helper (has_perm) + RLS come in step 2.
alter table profiles add column if not exists permissions jsonb not null default '{}'::jsonb;


-- ----------------------------------------------------------------------------
-- One-off data fixes applied (kept for the record):
--   • Backfilled the first released run to PR101-2606/0001.
--   • Set kg_per_bag overrides for 9 items whose codes don't show the pack size:
--       D041-4.5/CTN=4.5, BK1009-11.34/CTN=11.34, D958-2325-22.68/CTN=22.68,
--       D958-3032-22.68/CTN=22.68, S251-25G/BAG=25, S251-30G/BAG=30,
--       BK1013-1OKG/CTN=10, BK1089-30lbs/CTN=13.61, D029-3.8KGX5/BAG=17.5
--
-- NOTE: Objects created BEFORE this log (raise_material_request,
-- raise_combined_material_request, refresh_one_open_request,
-- refresh_open_material_requests, confirm_document_factory, approve/reject
-- change requests, my_factory_code(), item_stock, material_requests,
-- material_request_items, etc.) predate this file and live only in Supabase.
-- ----------------------------------------------------------------------------
