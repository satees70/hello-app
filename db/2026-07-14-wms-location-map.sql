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
