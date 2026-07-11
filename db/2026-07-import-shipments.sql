-- 2026-07 · Import Shipment Management — tracking tables (step 1 of the feature)
-- ============================================================================
-- WHY: a new Import section (import.srrieaswari.com) to track goods coming in
-- from overseas suppliers. This first step is SHIPMENT TRACKING.
--
-- Real-world shape modelled here:
--   • one ORDER (import_shipments) is placed on a SUPPLIER (fixed list)
--   • an order can arrive on MANY Bills of Lading (import_bills_of_lading)
--   • each BL can carry MANY CONTAINERS (import_containers)
--   • the order lists many ITEMS from the Items Master (import_shipment_items)
-- Demurrage / detention are charged PER CONTAINER, so their driving dates and
-- free-day allowances live on the container (with an optional override), and a
-- view (import_container_charges) turns them into chargeable day counts.
--
-- ⚠️  RUN THIS BY HAND in the Supabase SQL editor. It does NOT deploy with the
--     app code (see AGENTS.md). Safe to re-run — idempotent throughout
--     (create ... if not exists / create or replace / drop policy if exists).
--
-- SECURITY: 'import' is a RESTRICTED module — hidden unless Head Office grants
--     it, like HR / Driver. Reads need the 'import' VIEW permission; writes
--     need EDIT; deleting a whole record needs DELETE. Enforced IN THE DATABASE
--     via has_perm(), so even a direct anon-key call is checked. No `using
--     (true)` policies (per AGENTS.md).
-- ============================================================================


-- 1) Make 'import' a RESTRICTED module in the DB permission check ------------
-- has_perm() gives legacy users (empty permission grid) full access to every
-- module EXCEPT the restricted ones, which require an explicit grant. Add
-- 'import' to that list so an un-configured user is NOT silently let in.
create or replace function public.has_perm(p_module text, p_action text)
returns boolean language sql stable security definer set search_path = public as $$
  with me as (select role, permissions from profiles where id = auth.uid())
  select case
    when (select role from me) = 'admin' then true
    when (select permissions from me) is null or (select permissions from me) = '{}'::jsonb
      then p_module not in ('grinding', 'grinding_recipe', 'import')   -- restricted → need explicit grant
    else coalesce((((select permissions from me) -> p_module) ->> p_action)::boolean, false)
  end
$$;
grant execute on function public.has_perm(text, text) to authenticated, anon, service_role;


-- 2) Supplier master (the fixed list) ---------------------------------------
create table if not exists public.import_suppliers (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  country        text,
  contact_person text,
  email          text,
  phone          text,
  active         boolean not null default true,   -- hide old suppliers without deleting
  notes          text,
  created_by     uuid,
  created_at     timestamptz not null default now()
);
-- One supplier name only (case-insensitive), so the list stays clean.
create unique index if not exists import_suppliers_name_key on public.import_suppliers (lower(name));


-- 3) Shipment / order header ------------------------------------------------
create table if not exists public.import_shipments (
  id                       uuid primary key default gen_random_uuid(),
  reference                text not null,                 -- our reference / proforma-invoice no.
  supplier_id              uuid references public.import_suppliers(id),
  status                   text not null default 'Ordered'
    check (status in ('Ordered', 'Shipped', 'In Transit', 'Arrived', 'Customs Cleared', 'Received')),
  order_date               date,
  received_date            date,                           -- when the whole order was received
  destination_factory_code text,                           -- optional: where it lands (future use)
  notes                    text,
  created_by               uuid,
  created_by_name          text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists import_shipments_status   on public.import_shipments (status);
create index if not exists import_shipments_supplier on public.import_shipments (supplier_id);
create index if not exists import_shipments_created  on public.import_shipments (created_at desc);


-- 4) Bills of Lading — many per order ---------------------------------------
create table if not exists public.import_bills_of_lading (
  id                   uuid primary key default gen_random_uuid(),
  shipment_id          uuid not null references public.import_shipments(id) on delete cascade,
  bl_number            text,
  shipping_line        text,
  vessel               text,
  port_of_loading      text,
  port_of_discharge    text,
  shipped_date         date,          -- departed / on board
  eta                  date,          -- estimated arrival
  arrival_date         date,          -- vessel arrived / discharged
  customs_cleared_date date,
  -- free days the shipping line grants before charges start (default for this
  -- BL's containers; a container may override below)
  demurrage_free_days  integer,
  detention_free_days  integer,
  notes                text,
  created_at           timestamptz not null default now()
);
create index if not exists import_bl_shipment on public.import_bills_of_lading (shipment_id);


-- 5) Containers — many per order/BL, carry the demurrage/detention dates -----
create table if not exists public.import_containers (
  id                   uuid primary key default gen_random_uuid(),
  shipment_id          uuid not null references public.import_shipments(id) on delete cascade,
  bl_id                uuid references public.import_bills_of_lading(id) on delete set null,
  container_no         text,
  container_type       text,          -- e.g. 20GP / 40HC
  -- the three dates that drive the charges:
  available_date       date,          -- container discharged / available at port  → demurrage starts
  gate_out_date        date,          -- picked up from port  → demurrage stops, detention starts
  empty_returned_date  date,          -- empty returned to line  → detention stops
  -- optional per-container overrides of the BL's free days:
  demurrage_free_days  integer,
  detention_free_days  integer,
  notes                text,
  created_at           timestamptz not null default now()
);
create index if not exists import_containers_shipment on public.import_containers (shipment_id);
create index if not exists import_containers_bl        on public.import_containers (bl_id);
create index if not exists import_containers_no        on public.import_containers (container_no);


-- 6) Shipment items — each line links to the Items Master --------------------
-- item_id is the live link to items(id); item_code/description/unit are stored
-- as a snapshot so a historical shipment still reads correctly even if the
-- item master later changes. container_id is optional (assign a line to a
-- container later, when that feature is built).
create table if not exists public.import_shipment_items (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null references public.import_shipments(id) on delete cascade,
  container_id     uuid references public.import_containers(id) on delete set null,
  item_id          uuid references public.items(id),
  item_code        text not null,
  description      text,
  unit             text,
  quantity         numeric not null default 0,
  declared_weight  numeric,                                -- declared weight, kg
  created_at       timestamptz not null default now()
);
create index if not exists import_shipment_items_sid       on public.import_shipment_items (shipment_id);
create index if not exists import_shipment_items_container on public.import_shipment_items (container_id);
create index if not exists import_shipment_items_item      on public.import_shipment_items (item_id);


-- 7) Chargeable demurrage / detention days, per container --------------------
-- Counts up to TODAY while a container is still at port (no gate-out) or still
-- held (no empty-return), so the figures stay live. Free days fall back from
-- container → BL → 0. security_invoker so the caller's RLS still applies.
create or replace view public.import_container_charges
with (security_invoker = on) as
select
  c.id                                                            as container_id,
  c.shipment_id,
  c.container_no,
  coalesce(c.demurrage_free_days, bl.demurrage_free_days, 0)      as demurrage_free_days,
  coalesce(c.detention_free_days, bl.detention_free_days, 0)      as detention_free_days,
  -- Demurrage: available at port → picked up (or today if still sitting)
  greatest(
    0,
    (coalesce(c.gate_out_date, current_date) - c.available_date)
      - coalesce(c.demurrage_free_days, bl.demurrage_free_days, 0)
  )                                                               as demurrage_days,
  -- Detention: picked up → empty returned (or today if still held); only once
  -- the container has actually been picked up.
  case
    when c.gate_out_date is null then 0
    else greatest(
      0,
      (coalesce(c.empty_returned_date, current_date) - c.gate_out_date)
        - coalesce(c.detention_free_days, bl.detention_free_days, 0)
    )
  end                                                             as detention_days
from public.import_containers c
left join public.import_bills_of_lading bl on bl.id = c.bl_id;


-- 8) Keep updated_at fresh on the order header ------------------------------
create or replace function public.tg_import_shipment_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists import_shipment_touch on public.import_shipments;
create trigger import_shipment_touch before update on public.import_shipments
  for each row execute function public.tg_import_shipment_touch();


-- 9) Grants + Row Level Security --------------------------------------------
grant select, insert, update, delete on public.import_suppliers        to authenticated;
grant select, insert, update, delete on public.import_shipments        to authenticated;
grant select, insert, update, delete on public.import_bills_of_lading  to authenticated;
grant select, insert, update, delete on public.import_containers       to authenticated;
grant select, insert, update, delete on public.import_shipment_items   to authenticated;
grant select on public.import_container_charges to authenticated;

alter table public.import_suppliers        enable row level security;
alter table public.import_shipments        enable row level security;
alter table public.import_bills_of_lading  enable row level security;
alter table public.import_containers       enable row level security;
alter table public.import_shipment_items   enable row level security;

-- Same gate on every table: read = view, write = edit. A whole-record DELETE on
-- the two top-level tables needs the DELETE grant; child rows (BLs, containers,
-- items) are managed as part of EDITing an order, so their delete uses 'edit'.
do $$
declare
  t text;
  top_tables  text[] := array['import_suppliers', 'import_shipments'];
  child_tables text[] := array['import_bills_of_lading', 'import_containers', 'import_shipment_items'];
begin
  foreach t in array top_tables || child_tables loop
    execute format('drop policy if exists %I on public.%I', t || '_read',   t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select using (has_perm(''import'', ''view''))', t || '_read', t);
    execute format('create policy %I on public.%I for insert with check (has_perm(''import'', ''edit''))', t || '_insert', t);
    execute format('create policy %I on public.%I for update using (has_perm(''import'', ''edit'')) with check (has_perm(''import'', ''edit''))', t || '_update', t);
  end loop;
  foreach t in array top_tables loop
    execute format('create policy %I on public.%I for delete using (has_perm(''import'', ''delete''))', t || '_delete', t);
  end loop;
  foreach t in array child_tables loop
    execute format('create policy %I on public.%I for delete using (has_perm(''import'', ''edit''))', t || '_delete', t);
  end loop;
end $$;
