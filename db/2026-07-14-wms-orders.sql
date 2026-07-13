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
