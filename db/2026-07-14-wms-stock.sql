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
