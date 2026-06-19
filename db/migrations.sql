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


-- ============================================================================
-- 2026-06 · Office-only access (IP allow-list per factory)
-- ============================================================================
-- Factory staff can only use the app from an office network (an allowed IP);
-- Head Office + Admins are exempt (checked in the client, not here). Allowed IPs
-- are managed by Head Office on /admin/allowed-networks. A master switch lets the
-- whole thing be turned on/off safely (default OFF so nobody is locked out until
-- it's configured and switched on).

create table if not exists public.allowed_networks (
  id uuid primary key default gen_random_uuid(),
  label text,                                   -- e.g. "AVINA102 office"
  ip text not null,                             -- public IP as shown by whatismyipaddress
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.allowed_networks to authenticated, anon, service_role;
alter table public.allowed_networks enable row level security;
drop policy if exists an_read on public.allowed_networks;
create policy an_read on public.allowed_networks for select using (true);
drop policy if exists an_write on public.allowed_networks;
create policy an_write on public.allowed_networks for all
  using (my_factory_code() = 'HEAD_OFFICE') with check (my_factory_code() = 'HEAD_OFFICE');

-- Single-row app settings (id is always 1). Master switch for the IP guard.
create table if not exists public.app_config (
  id int primary key default 1,
  network_guard_enabled boolean not null default false,
  constraint app_config_single check (id = 1)
);
insert into public.app_config (id) values (1) on conflict do nothing;
grant select, insert, update, delete on public.app_config to authenticated, anon, service_role;
alter table public.app_config enable row level security;
drop policy if exists ac_read on public.app_config;
create policy ac_read on public.app_config for select using (true);
drop policy if exists ac_write on public.app_config;
create policy ac_write on public.app_config for all
  using (my_factory_code() = 'HEAD_OFFICE') with check (my_factory_code() = 'HEAD_OFFICE');


-- ============================================================================
-- 2026-06 · Grinding & Mixing Record (P07-F10) — restricted process screen
-- ============================================================================
-- A grinding/mixing log (controlled form P07-F10 Ver.02). Each record can list
-- several raw materials (a mixture) in `materials` jsonb [{item, qty}]. Visible
-- only to users explicitly granted the 'grinding' permission section (restricted
-- by default). Factory-scoped (multi-factory aware via my_factory_codes()).
create table if not exists public.grinding_records (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null,
  month_year text,
  record_date date,
  product text,
  product_batch_no text,
  materials jsonb not null default '[]'::jsonb,   -- [{ item, qty }]
  machine text,
  crusher_before text,                            -- crusher condition before production
  crusher_after text,                             -- crusher condition after production
  qty_rework numeric,
  qty_rejection numeric,
  correction_action text,
  prepared_by text,
  verified_by text,
  remark text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists grinding_records_factory on public.grinding_records(factory_code, record_date);
grant select, insert, update, delete on public.grinding_records to authenticated, anon, service_role;
alter table public.grinding_records enable row level security;
drop policy if exists gr_read on public.grinding_records;
create policy gr_read on public.grinding_records for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));
drop policy if exists gr_write on public.grinding_records;
create policy gr_write on public.grinding_records for all
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()))
  with check (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));


-- ============================================================================
-- 2026-06 · Grinding recipe locked away from QC (DB-enforced field separation)
-- ============================================================================
-- The raw-material mixture (formula) must be hidden from QC, who still do the
-- inspection. So the mixture moves to its own table, gated by a NEW permission
-- 'grinding_recipe' enforced in the database via has_perm(). QC gets 'grinding'
-- (inspection) only; operators get both.

-- Permission check mirroring lib/permissions.ts can(): admins full; restricted
-- sections need an explicit grant; otherwise unconfigured = full (legacy).
create or replace function public.has_perm(p_module text, p_action text)
returns boolean language sql stable security definer set search_path = public as $$
  with me as (select role, permissions from profiles where id = auth.uid())
  select case
    when (select role from me) = 'admin' then true
    when (select permissions from me) is null or (select permissions from me) = '{}'::jsonb
      then p_module not in ('grinding', 'grinding_recipe')   -- restricted → need explicit grant
    else coalesce((((select permissions from me) -> p_module) ->> p_action)::boolean, false)
  end
$$;
grant execute on function public.has_perm(text, text) to authenticated, anon, service_role;

-- The locked recipe/mixture (one row per raw material in a grinding record).
create table if not exists public.grinding_materials (
  id uuid primary key default gen_random_uuid(),
  grinding_record_id uuid not null references public.grinding_records(id) on delete cascade,
  factory_code text not null,
  item text,
  qty text,
  created_at timestamptz not null default now()
);
create index if not exists grinding_materials_record on public.grinding_materials(grinding_record_id);
grant select, insert, update, delete on public.grinding_materials to authenticated, anon, service_role;
alter table public.grinding_materials enable row level security;
-- Read/write the mixture ONLY with the grinding_recipe permission (+ own factory).
drop policy if exists gm_read on public.grinding_materials;
create policy gm_read on public.grinding_materials for select
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'view'));
drop policy if exists gm_write on public.grinding_materials;
create policy gm_write on public.grinding_materials for all
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'))
  with check ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'));

-- Move any existing inline mixture (jsonb) into the locked table, then it's unused.
insert into public.grinding_materials (grinding_record_id, factory_code, item, qty)
select gr.id, gr.factory_code, m->>'item', m->>'qty'
from public.grinding_records gr, jsonb_array_elements(gr.materials) m
where jsonb_typeof(gr.materials) = 'array' and gr.materials <> '[]'::jsonb;

-- Tighten the grinding RECORD (inspection) to the 'grinding' permission too.
drop policy if exists gr_read on public.grinding_records;
create policy gr_read on public.grinding_records for select
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding', 'view'));
drop policy if exists gr_write on public.grinding_records;
create policy gr_write on public.grinding_records for all
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding', 'edit'))
  with check ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding', 'edit'));


-- ============================================================================
-- 2026-06 · Grinding recipes (preset formula) + lot-multiplier production
-- ============================================================================
-- Mixer presets a formula per product; operators just pick product + #lots and
-- the secure produce_grinding() multiplies the per-lot quantities. Operators see
-- only the product name (recipe HEADER read by 'grinding'); the COMPONENTS
-- (quantities) are read only with 'grinding_recipe' (the mixer / QC blocked).

create table if not exists public.grinding_recipes (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null,
  product text not null,
  recipe_type text not null default 'mixing',   -- 'direct' | 'mixing'
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.grinding_recipes to authenticated, anon, service_role;
alter table public.grinding_recipes enable row level security;
-- Header (product name) visible to grinding operators so they can pick it.
drop policy if exists grec_read on public.grinding_recipes;
create policy grec_read on public.grinding_recipes for select
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding', 'view'));
-- Only the mixer (recipe permission) creates/edits recipes.
drop policy if exists grec_write on public.grinding_recipes;
create policy grec_write on public.grinding_recipes for all
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'))
  with check ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'));

-- The secret quantities (per lot). Readable only with the recipe permission.
create table if not exists public.grinding_recipe_components (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.grinding_recipes(id) on delete cascade,
  factory_code text not null,
  item text not null,
  qty_per_lot numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists grec_comp_recipe on public.grinding_recipe_components(recipe_id);
grant select, insert, update, delete on public.grinding_recipe_components to authenticated, anon, service_role;
alter table public.grinding_recipe_components enable row level security;
drop policy if exists grc_read on public.grinding_recipe_components;
create policy grc_read on public.grinding_recipe_components for select
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'view'));
drop policy if exists grc_write on public.grinding_recipe_components;
create policy grc_write on public.grinding_recipe_components for all
  using ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'))
  with check ((my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())) and has_perm('grinding_recipe', 'edit'));

-- Link production records to a recipe + lots.
alter table public.grinding_records add column if not exists recipe_id uuid references public.grinding_recipes(id);
alter table public.grinding_records add column if not exists lots numeric;
alter table public.grinding_records add column if not exists recipe_type text;

-- Operator produces N lots of a recipe; computes the (hidden) mixture as definer
-- so the operator never needs to read the formula.
create or replace function public.produce_grinding(p_recipe_id uuid, p_lots numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_rec public.grinding_recipes; v_id uuid; c record;
begin
  if not has_perm('grinding', 'edit') then raise exception 'Not allowed to record grinding'; end if;
  if p_lots is null or p_lots <= 0 then raise exception 'Number of lots must be greater than zero'; end if;
  select * into v_rec from public.grinding_recipes where id = p_recipe_id;
  if not found then raise exception 'Recipe not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_rec.factory_code = any (my_factory_codes())) then
    raise exception 'Not allowed for this factory'; end if;
  insert into public.grinding_records (factory_code, product, recipe_id, lots, recipe_type, record_date, month_year, created_by)
  values (v_rec.factory_code, v_rec.product, p_recipe_id, p_lots, v_rec.recipe_type,
          (now() at time zone 'Asia/Kuala_Lumpur')::date,
          to_char(now() at time zone 'Asia/Kuala_Lumpur', 'MM/YYYY'), auth.uid())
  returning id into v_id;
  for c in select item, qty_per_lot from public.grinding_recipe_components where recipe_id = p_recipe_id loop
    insert into public.grinding_materials (grinding_record_id, factory_code, item, qty)
    values (v_id, v_rec.factory_code, c.item, (c.qty_per_lot * p_lots)::text);
  end loop;
  return v_id;
end $$;
grant execute on function public.produce_grinding(uuid, numeric) to authenticated;


-- ============================================================================
-- 2026-06 · Grinding mixing details: per-material batch + added tick, mix times
-- ============================================================================
-- When the mixer prepares a produced batch, they record each raw material's
-- batch number and tick it as added; the record gets mix start/end times.
alter table public.grinding_materials add column if not exists batch_no text;
alter table public.grinding_materials add column if not exists added boolean not null default false;
alter table public.grinding_records add column if not exists mix_start text;   -- HH:MM
alter table public.grinding_records add column if not exists mix_end text;     -- HH:MM


-- ============================================================================
-- 2026-06 · Process inspection forms: Drying/Roasting (P07-F05), Moisture
--           (P07-F08), OPRP (P07-F03). Factory-scoped record logs.
-- ============================================================================
-- Helper note: all three are simple factory-scoped logs (same RLS shape as
-- stock_lots), shown under the Production permission. Rendered by the shared
-- ProcessLog component from a fields config per page.

create table if not exists public.drying_roasting_records (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null, month_year text, record_date date,
  product text, rm_batch_no text, product_batch_no text, qty_in numeric, qty_out numeric, machine text,
  oven_temp text, oven_achieve_temp text, oven_time_start text, oven_time_finish text,
  roast_temp text, roast_achieve_temp text, roast_time_start text, roast_time_finish text,
  moisture_before text, moisture_after text, done_by text, verified_by text, remark text,
  created_by uuid, created_at timestamptz not null default now()
);

create table if not exists public.moisture_records (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null, month_year text, record_date date,
  product text, batch_no text, sample_from text, product_desc text, sample_prep text,
  weight_g numeric, time_min numeric, moisture_pct text, remarks text, checked_by text, verified_by text,
  created_by uuid, created_at timestamptz not null default now()
);

create table if not exists public.oprp_records (
  id uuid primary key default gen_random_uuid(),
  factory_code text not null, month_year text, record_date date,
  product text, batch_no_old text, batch_no_new text, taken_qty numeric, out_qty numeric,
  time_in text, time_out text, machine text, machine_before text, machine_after text,
  sieve_size text, sieve_before text, sieve_after text, weight_residue numeric, weight_waste numeric,
  handpick_result text, visual_result text, needle_condition text, seal_integrity text,
  done_by text, verified_by text, remark text,
  created_by uuid, created_at timestamptz not null default now()
);

-- Same factory-scoped RLS for all three (HO or one of the user's factories).
do $$
declare t text;
begin
  foreach t in array array['drying_roasting_records', 'moisture_records', 'oprp_records'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated, anon, service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select using (my_factory_code() = ''HEAD_OFFICE'' or factory_code = any (my_factory_codes()))', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all using (my_factory_code() = ''HEAD_OFFICE'' or factory_code = any (my_factory_codes())) with check (my_factory_code() = ''HEAD_OFFICE'' or factory_code = any (my_factory_codes()))', t || '_write', t);
  end loop;
end $$;


-- ============================================================================
-- 2026-06 · Timer cancellation requests (accidental Start/Stop → HO approval)
-- ============================================================================
-- A user can request to cancel a timer they pressed by mistake; it appears in
-- Pending Changes; Head Office approves → the specific timer fields are cleared.
create table if not exists public.correction_requests (
  id uuid primary key default gen_random_uuid(),
  factory_code text,
  table_name text not null,
  record_id uuid not null,
  timer_key text not null,           -- which timer: grinding_mix / drying_oven / drying_roast / oprp_process / inspection_production
  label text,
  reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.correction_requests to authenticated, anon, service_role;
grant update, delete on public.correction_requests to service_role;
alter table public.correction_requests enable row level security;
drop policy if exists cr_read on public.correction_requests;
create policy cr_read on public.correction_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists cr_insert on public.correction_requests;
create policy cr_insert on public.correction_requests for insert with check (requested_by = auth.uid());

-- Approve: HO only; clears the specific timer fields for the known timer_key.
create or replace function public.approve_correction(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.correction_requests; v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.correction_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  case r.timer_key
    when 'grinding_mix' then update public.grinding_records set mix_timer = null, mix_start = null, mix_end = null where id = r.record_id;
    when 'drying_oven' then update public.drying_roasting_records set oven_time_start = null, oven_time_finish = null where id = r.record_id;
    when 'drying_roast' then update public.drying_roasting_records set roast_time_start = null, roast_time_finish = null where id = r.record_id;
    when 'oprp_process' then update public.oprp_records set time_in = null, time_out = null where id = r.record_id;
    when 'inspection_production' then update public.inspection_records set data = (data - 'timer' - 'prod_start' - 'prod_end') where id = r.record_id;
    else raise exception 'Unknown timer key %', r.timer_key;
  end case;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.correction_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_correction(uuid) to authenticated;

create or replace function public.reject_correction(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.correction_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_correction(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · Drying/Roasting moves stock: same item, new batch (e.g. 260606AH)
-- ============================================================================
-- Roasting is an extra process: consume qty_in of the old batch and create a new
-- batch (same item) with qty_out (the weight loss is the difference). One-shot
-- per record (stock_applied guard). Product field holds "CODE — DESCRIPTION".
alter table public.drying_roasting_records add column if not exists stock_applied boolean not null default false;

create or replace function public.process_drying_stock(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.drying_roasting_records; v_code text; v_item public.items; v_need numeric; v_take numeric; v_avail numeric; c record;
begin
  if not has_perm('production', 'edit') then raise exception 'Not allowed to record production'; end if;
  select * into r from public.drying_roasting_records where id = p_id;
  if not found then raise exception 'Record not found'; end if;
  if r.stock_applied then raise exception 'Stock has already been moved for this record'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (r.factory_code = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
  if r.qty_in is null or r.qty_in <= 0 then raise exception 'Enter Qty in (kg)'; end if;
  if r.qty_out is null or r.qty_out <= 0 then raise exception 'Enter Qty out (kg)'; end if;
  if coalesce(r.rm_batch_no, '') = '' then raise exception 'Enter the batch before oven'; end if;
  if coalesce(r.product_batch_no, '') = '' then raise exception 'Enter the new batch after oven'; end if;
  v_code := trim(split_part(coalesce(r.product, ''), '—', 1));
  select * into v_item from public.items where code = v_code limit 1;
  if not found then raise exception 'Item % not found in Items master', v_code; end if;
  select coalesce(sum(qty_remaining), 0) into v_avail from public.stock_lots
    where item_id = v_item.id and factory_code = r.factory_code and batch_no = r.rm_batch_no;
  if v_avail < r.qty_in then raise exception 'Not enough stock of batch % (have %, need %)', r.rm_batch_no, v_avail, r.qty_in; end if;
  v_need := r.qty_in;
  for c in select id, qty_remaining from public.stock_lots
           where item_id = v_item.id and factory_code = r.factory_code and batch_no = r.rm_batch_no and qty_remaining > 0
           order by exp_date asc nulls last, received_at asc loop
    exit when v_need <= 0;
    v_take := least(v_need, c.qty_remaining);
    update public.stock_lots set qty_remaining = qty_remaining - v_take where id = c.id;
    v_need := v_need - v_take;
  end loop;
  insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining)
  values (v_item.id, v_item.code, v_item.description, r.factory_code, r.product_batch_no, null, r.qty_out, r.qty_out);
  update public.item_stock set quantity = quantity - r.qty_in + r.qty_out, updated_at = now()
    where item_id = v_item.id and factory_code = r.factory_code;
  if not found then
    insert into public.item_stock (item_id, factory_code, quantity, updated_at) values (v_item.id, r.factory_code, r.qty_out - r.qty_in, now());
  end if;
  update public.drying_roasting_records set stock_applied = true where id = p_id;
end $$;
grant execute on function public.process_drying_stock(uuid) to authenticated;


-- ============================================================================
-- 2026-06 · Goods Received line edit/delete with Head Office approval
-- ============================================================================
-- Each received line records what it booked, so an approved delete can reverse
-- exactly that stock. Edits/deletes go through do_change_requests (like sales).
alter table public.delivery_order_lines add column if not exists stock_lot_id uuid;
alter table public.delivery_order_lines add column if not exists received_qty numeric;

create table if not exists public.do_change_requests (
  id uuid primary key default gen_random_uuid(),
  do_id uuid references public.delivery_orders(id) on delete cascade,
  line_id uuid references public.delivery_order_lines(id) on delete set null,
  factory_code text,
  request_type text not null,                 -- 'edit' | 'delete'
  field text, old_value text, new_value text,
  line_label text, reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.do_change_requests to authenticated, anon, service_role;
grant update, delete on public.do_change_requests to service_role;
alter table public.do_change_requests enable row level security;
drop policy if exists docr_read on public.do_change_requests;
create policy docr_read on public.do_change_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists docr_insert on public.do_change_requests;
create policy docr_insert on public.do_change_requests for insert with check (requested_by = auth.uid());

create or replace function public.approve_do_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.do_change_requests; v_l public.delivery_order_lines; v_lot public.stock_lots; v_name text; v_reqid uuid;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.do_change_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  select * into v_l from public.delivery_order_lines where id = r.line_id;

  if r.request_type = 'edit' then
    if not found then raise exception 'That line no longer exists'; end if;
    if r.field not in ('item_code','description','quantity','unit','batch_no') then raise exception 'Field % cannot be edited', r.field; end if;
    if v_l.received_at is not null and r.field in ('item_code','quantity','unit','batch_no') then
      raise exception 'Line already received — delete it and receive again to change %', r.field;
    end if;
    if r.field = 'quantity' then
      update public.delivery_order_lines set quantity = nullif(r.new_value,'')::numeric where id = r.line_id;
    else
      execute format('update public.delivery_order_lines set %I = $1 where id = $2', r.field) using nullif(r.new_value,''), r.line_id;
    end if;

  elsif r.request_type = 'delete' then
    if found and v_l.received_at is not null then
      if v_l.stock_lot_id is null then raise exception 'This receipt predates the feature — reverse its stock manually, then delete'; end if;
      select * into v_lot from public.stock_lots where id = v_l.stock_lot_id;
      if found then
        if v_lot.qty_remaining < coalesce(v_l.received_qty, 0) then
          raise exception 'This batch has already been partly used in production — cannot reverse automatically. Fix stock manually.';
        end if;
        update public.stock_lots set qty_remaining = qty_remaining - coalesce(v_l.received_qty, 0) where id = v_lot.id;
        update public.item_stock set quantity = quantity - coalesce(v_l.received_qty, 0), updated_at = now()
          where item_id = v_lot.item_id and factory_code = v_lot.factory_code;
        if v_lot.request_item_id is not null then
          update public.material_request_items set received_qty = greatest(received_qty - coalesce(v_l.received_qty, 0), 0) where id = v_lot.request_item_id;
          select request_id into v_reqid from public.material_request_items where id = v_lot.request_item_id;
          update public.material_requests set status =
            case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = v_reqid) then 'Fulfilled'
                 when (select bool_or(received_qty > 0) from public.material_request_items where request_id = v_reqid) then 'Partially Received'
                 else 'Open' end
          where id = v_reqid;
        end if;
      end if;
    end if;
    delete from public.delivery_order_lines where id = r.line_id;
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  update public.do_change_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_do_change(uuid) to authenticated;

create or replace function public.reject_do_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.do_change_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_do_change(uuid) to authenticated;


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
