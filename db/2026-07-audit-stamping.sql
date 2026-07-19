-- Audit stamping for money- / stock-affecting actions that recorded no actor.
-- ----------------------------------------------------------------------------
-- Adds "who + when" (and a small history where the row is deleted) to actions that
-- previously left no trail: a manual stock override, pre-confirmation sales-line
-- edits/deletes, whole-document deletes, and the delivery "invoiced" toggle.
-- Actor is always the AUTHENTICATED caller (auth.uid()) — never client-supplied.
-- Recreated RPCs are faithful copies of their current bodies with only the audit
-- write added. Audit tables are readable by the relevant module (RLS), and written
-- only by these SECURITY DEFINER functions.
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- ============================================================================

-- ---------- audit tables ----------
create table if not exists public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  item_id uuid, factory_code text, old_qty numeric, new_qty numeric,
  set_by uuid, set_by_name text, created_at timestamptz default now()
);
create table if not exists public.sales_line_audit (
  id uuid primary key default gen_random_uuid(),
  line_id uuid, import_id uuid, so_number text, item_code text, action text,   -- 'edit' | 'delete'
  customer_name text, quantity numeric, outstanding_qty numeric, delivery_date text, location_code text, factory_code text,
  actor uuid, actor_name text, created_at timestamptz default now()
);
create table if not exists public.sales_import_deletions (
  id uuid primary key default gen_random_uuid(),
  import_id uuid, file_name text, file_path text, factory_code text,
  line_count int, change_request_count int,
  deleted_by uuid, deleted_by_name text, created_at timestamptz default now()
);

alter table public.stock_adjustments      enable row level security;
alter table public.sales_line_audit       enable row level security;
alter table public.sales_import_deletions enable row level security;
drop policy if exists sa_read  on public.stock_adjustments;
drop policy if exists sla_read on public.sales_line_audit;
drop policy if exists sid_read on public.sales_import_deletions;
create policy sa_read  on public.stock_adjustments      for select to authenticated using (public.is_ho_or_admin() or public.has_perm('packing','view'));
create policy sla_read on public.sales_line_audit       for select to authenticated using (public.is_ho_or_admin() or public.has_perm('sales','view'));
create policy sid_read on public.sales_import_deletions for select to authenticated using (public.is_ho_or_admin() or public.has_perm('sales','view'));

-- ---------- B1: set_item_stock — record who set the on-hand + old→new ----------
create or replace function public.set_item_stock(p_item_id uuid, p_factory text, p_qty numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_old numeric;
begin
  if not has_perm('packing','edit') then raise exception 'Not allowed to edit stock'; end if;
  if p_item_id is null or coalesce(p_factory,'') = '' then raise exception 'Item and factory are required'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (p_factory = any (my_factory_codes())) then
    raise exception 'Not allowed for this factory'; end if;
  if p_qty is null then raise exception 'Enter a stock quantity'; end if;
  select quantity into v_old from public.item_stock where item_id = p_item_id and factory_code = p_factory;
  -- Absolute set (not add), negative allowed on purpose.
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (p_item_id, p_factory, p_qty, now())
  on conflict (item_id, factory_code) do update set quantity = excluded.quantity, updated_at = now();
  insert into public.stock_adjustments (item_id, factory_code, old_qty, new_qty, set_by, set_by_name)
  values (p_item_id, p_factory, v_old, p_qty, auth.uid(), (select full_name from public.profiles where id = auth.uid()));
end $$;
grant execute on function public.set_item_stock(uuid, text, numeric) to authenticated, anon, service_role;

-- ---------- A1: pre-confirmation sales-line edit / delete — history rows ----------
create or replace function public.delete_unconfirmed_sales_line(p_line_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_line public.sales_order_lines;
begin
  select * into v_line from public.sales_order_lines where id = p_line_id;
  if not found then return; end if;
  if not has_perm('sales', 'edit') then raise exception 'Not allowed'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and coalesce(v_line.factory_code, '') <> '' and v_line.factory_code <> all(my_factory_codes()) then
    raise exception 'Not allowed for this factory'; end if;
  if coalesce(v_line.factory_code, '') <> '' and exists (
       select 1 from public.document_confirmations dc
        where dc.import_id = v_line.import_id and dc.factory_code = v_line.factory_code)
  then raise exception 'Already confirmed — deletion needs Head Office approval'; end if;
  insert into public.sales_line_audit (line_id, import_id, so_number, item_code, action, customer_name, quantity, outstanding_qty, delivery_date, location_code, factory_code, actor, actor_name)
  values (v_line.id, v_line.import_id, v_line.so_number, v_line.item_code, 'delete', v_line.customer_name, v_line.quantity, v_line.outstanding_qty, v_line.delivery_date, v_line.location_code, v_line.factory_code, auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  delete from public.sales_order_lines where id = p_line_id;
end; $function$;
grant execute on function public.delete_unconfirmed_sales_line(uuid) to authenticated;

create or replace function public.edit_unconfirmed_sales_line(
  p_line_id uuid, p_customer text, p_so_number text, p_item_code text, p_description text,
  p_quantity text, p_outstanding text, p_delivery_date text, p_location text)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_line public.sales_order_lines;
begin
  select * into v_line from public.sales_order_lines where id = p_line_id;
  if not found then raise exception 'Line not found'; end if;
  if not has_perm('sales', 'edit') then raise exception 'Not allowed'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' then
    p_customer := null; p_so_number := null; p_item_code := null; p_description := null;
    p_quantity := null; p_outstanding := null;
  end if;
  if coalesce(v_line.factory_code, '') <> '' and exists (
       select 1 from public.document_confirmations dc
        where dc.import_id = v_line.import_id and dc.factory_code = v_line.factory_code)
  then raise exception 'Already confirmed — changes need Head Office approval'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and (p_customer is not null or p_so_number is not null
       or p_item_code is not null or p_description is not null or p_quantity is not null or p_outstanding is not null)
  then raise exception 'Only Location and Delivery Date can be changed'; end if;

  -- Snapshot the values BEFORE the change (v_line still holds the old row).
  insert into public.sales_line_audit (line_id, import_id, so_number, item_code, action, customer_name, quantity, outstanding_qty, delivery_date, location_code, factory_code, actor, actor_name)
  values (v_line.id, v_line.import_id, v_line.so_number, v_line.item_code, 'edit', v_line.customer_name, v_line.quantity, v_line.outstanding_qty, v_line.delivery_date, v_line.location_code, v_line.factory_code, auth.uid(), (select full_name from public.profiles where id = auth.uid()));

  update public.sales_order_lines set
    customer_name   = coalesce(p_customer, customer_name),
    so_number       = coalesce(p_so_number, so_number),
    item_code       = coalesce(p_item_code, item_code),
    description     = coalesce(p_description, description),
    quantity        = coalesce(p_quantity::numeric, quantity),
    outstanding_qty = coalesce(p_outstanding::numeric, outstanding_qty),
    delivery_date   = coalesce(nullif(p_delivery_date, ''), delivery_date),
    location_code   = coalesce(p_location, location_code)
  where id = p_line_id;

  if p_location is not null then
    update public.sales_order_lines sol set factory_code = lm.factory_code
      from public.location_map lm
     where sol.id = p_line_id
       and btrim(upper(lm.location_code)) = btrim(upper(coalesce(sol.location_code, '')))
       and coalesce(lm.factory_code, '') <> '';
  end if;
end; $function$;
grant execute on function public.edit_unconfirmed_sales_line(uuid, text, text, text, text, text, text, text, text) to authenticated;

-- ---------- A2: whole-document delete — audit row + cascade ----------
create or replace function public.delete_sales_document(p_import_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_imp public.sales_imports; v_lines int; v_crs int;
begin
  if not is_ho_or_admin() then raise exception 'Only Head Office can delete a document'; end if;
  select * into v_imp from public.sales_imports where id = p_import_id;
  if not found then return; end if;
  select count(*) into v_lines from public.sales_order_lines where import_id = p_import_id;
  select count(*) into v_crs   from public.change_requests   where import_id = p_import_id;
  insert into public.sales_import_deletions (import_id, file_name, file_path, factory_code, line_count, change_request_count, deleted_by, deleted_by_name)
  values (p_import_id, v_imp.file_name, v_imp.file_path, v_imp.factory_code, v_lines, v_crs, auth.uid(), (select full_name from public.profiles where id = auth.uid()));
  delete from public.sales_imports where id = p_import_id;   -- FK cascade removes lines + change_requests
end $$;
grant execute on function public.delete_sales_document(uuid) to authenticated;

-- ---------- A3: delivery_schedule.invoiced — stamp who/when on the toggle ----------
alter table public.delivery_schedule add column if not exists invoiced_by uuid;
alter table public.delivery_schedule add column if not exists invoiced_at timestamptz;

create or replace function public.tg_stamp_invoiced() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(NEW.invoiced, false) and not coalesce(OLD.invoiced, false) then
    NEW.invoiced_by := auth.uid(); NEW.invoiced_at := now();
  elsif not coalesce(NEW.invoiced, false) and coalesce(OLD.invoiced, false) then
    NEW.invoiced_by := null; NEW.invoiced_at := null;
  end if;
  return NEW;
end $$;
drop trigger if exists trg_stamp_invoiced on public.delivery_schedule;
create trigger trg_stamp_invoiced before update on public.delivery_schedule
  for each row execute function public.tg_stamp_invoiced();

notify pgrst, 'reload schema';
