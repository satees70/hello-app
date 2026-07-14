-- WMS: supplier list with a short code used to tag batch numbers.
-- Run in the Supabase SQL editor. Idempotent.
create table if not exists public.wms_suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null,            -- short tag appended to batch numbers, e.g. ABC
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);
create unique index if not exists wms_suppliers_code on public.wms_suppliers(upper(code));
create index if not exists wms_suppliers_name on public.wms_suppliers(lower(name));

grant select, insert, update, delete on public.wms_suppliers to authenticated, anon, service_role;
alter table public.wms_suppliers enable row level security;
drop policy if exists wms_suppliers_read on public.wms_suppliers;
create policy wms_suppliers_read on public.wms_suppliers for select using (has_perm('warehouse','view'));
drop policy if exists wms_suppliers_write on public.wms_suppliers;
create policy wms_suppliers_write on public.wms_suppliers for all using (has_perm('warehouse','edit')) with check (has_perm('warehouse','edit'));

notify pgrst, 'reload schema';
