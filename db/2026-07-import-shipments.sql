-- 2026-07 · Import Shipment Management — tracking tables (step 1 of the feature)
-- ============================================================================
-- WHY: a new Import section (import.srrieaswari.com) to track goods coming in
-- from overseas suppliers. This first step is SHIPMENT TRACKING only: a
-- shipment record (supplier, reference, container, key dates, status) that
-- holds many Items-Master lines, each with a quantity and a declared weight.
-- The tables are deliberately simple so more features (documents, costs,
-- customs duty, per-line landed cost, etc.) can be added later with ALTERs.
--
-- ⚠️  RUN THIS BY HAND in the Supabase SQL editor. It does NOT deploy with the
--     app code (see AGENTS.md). Safe to re-run — it is idempotent
--     (create ... if not exists / create or replace / drop policy if exists).
--
-- SECURITY: 'import' is a RESTRICTED module — hidden unless Head Office grants
--     it, exactly like HR and Driver. Reads need the 'import' VIEW permission;
--     writes need EDIT; deleting a whole shipment needs DELETE. This is
--     enforced IN THE DATABASE via has_perm(), so even a direct call with the
--     browser's anon key is checked. No `using (true)` policies (per AGENTS.md).
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


-- 2) Shipment header --------------------------------------------------------
create table if not exists public.import_shipments (
  id                       uuid primary key default gen_random_uuid(),
  reference                text not null,                 -- our reference / proforma-invoice no.
  supplier                 text not null,                 -- supplier name (free text, like supplier_orders)
  container_no             text,                          -- container number (filled once known)
  status                   text not null default 'Ordered'
    check (status in ('Ordered', 'Shipped', 'In Transit', 'Arrived', 'Customs Cleared', 'Received')),
  -- key dates — filled in as the shipment moves along its lifecycle
  order_date               date,
  shipped_date             date,
  eta                      date,                           -- estimated time of arrival
  arrival_date             date,                           -- actual arrival at port
  customs_cleared_date     date,
  received_date            date,
  destination_factory_code text,                           -- optional: where it lands (future use)
  notes                    text,
  created_by               uuid,
  created_by_name          text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index if not exists import_shipments_status   on public.import_shipments (status);
create index if not exists import_shipments_supplier on public.import_shipments (supplier);
create index if not exists import_shipments_created  on public.import_shipments (created_at desc);


-- 3) Shipment items — each line links to the Items Master -------------------
-- item_id is the live link to items(id); item_code/description/unit are stored
-- as a snapshot so a historical shipment still reads correctly even if the
-- item master later changes.
create table if not exists public.import_shipment_items (
  id               uuid primary key default gen_random_uuid(),
  shipment_id      uuid not null references public.import_shipments(id) on delete cascade,
  item_id          uuid references public.items(id),      -- link to Items Master
  item_code        text not null,                          -- snapshot of the code
  description      text,                                   -- snapshot of the description
  unit             text,                                   -- snapshot of the unit
  quantity         numeric not null default 0,
  declared_weight  numeric,                                -- declared weight, kg
  created_at       timestamptz not null default now()
);
create index if not exists import_shipment_items_sid  on public.import_shipment_items (shipment_id);
create index if not exists import_shipment_items_item on public.import_shipment_items (item_id);


-- 4) Keep updated_at fresh on the header ------------------------------------
create or replace function public.tg_import_shipment_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists import_shipment_touch on public.import_shipments;
create trigger import_shipment_touch before update on public.import_shipments
  for each row execute function public.tg_import_shipment_touch();


-- 5) Grants + Row Level Security -------------------------------------------
grant select, insert, update, delete on public.import_shipments      to authenticated;
grant select, insert, update, delete on public.import_shipment_items to authenticated;

alter table public.import_shipments      enable row level security;
alter table public.import_shipment_items enable row level security;

-- Header: read = view, write = edit, delete-whole-shipment = delete.
drop policy if exists import_shipments_read   on public.import_shipments;
drop policy if exists import_shipments_insert on public.import_shipments;
drop policy if exists import_shipments_update on public.import_shipments;
drop policy if exists import_shipments_delete on public.import_shipments;
create policy import_shipments_read   on public.import_shipments for select using (has_perm('import', 'view'));
create policy import_shipments_insert on public.import_shipments for insert with check (has_perm('import', 'edit'));
create policy import_shipments_update on public.import_shipments for update using (has_perm('import', 'edit')) with check (has_perm('import', 'edit'));
create policy import_shipments_delete on public.import_shipments for delete using (has_perm('import', 'delete'));

-- Lines: adding/removing lines is part of EDITing a shipment, so line delete
-- uses 'edit' (not 'delete' — that is reserved for removing a whole shipment).
drop policy if exists import_items_read   on public.import_shipment_items;
drop policy if exists import_items_insert on public.import_shipment_items;
drop policy if exists import_items_update on public.import_shipment_items;
drop policy if exists import_items_delete on public.import_shipment_items;
create policy import_items_read   on public.import_shipment_items for select using (has_perm('import', 'view'));
create policy import_items_insert on public.import_shipment_items for insert with check (has_perm('import', 'edit'));
create policy import_items_update on public.import_shipment_items for update using (has_perm('import', 'edit')) with check (has_perm('import', 'edit'));
create policy import_items_delete on public.import_shipment_items for delete using (has_perm('import', 'edit'));
