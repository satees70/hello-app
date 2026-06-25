-- ============================================================================
-- SESSION CATCH-UP — run this once in the Supabase SQL Editor.
-- Bundles every database change from this session. Safe to run more than once
-- (idempotent: create-or-replace / if-not-exists / drop-if-exists).
-- ============================================================================

-- ─── 1) Repacking (own tables; factory approves; no sales-order posting) ─────
create sequence if not exists public.repack_seq;
create table if not exists public.repack_orders (
  id uuid primary key default gen_random_uuid(),
  repack_no text, factory_code text not null, note text, delivery_date date,
  status text not null default 'Pending',
  created_by uuid, created_by_name text, created_at timestamptz not null default now(),
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz
);
create table if not exists public.repack_order_items (
  id uuid primary key default gen_random_uuid(),
  repack_id uuid not null references public.repack_orders(id) on delete cascade,
  item_code text, description text, unit text, qty numeric
);
create index if not exists roi_repack on public.repack_order_items(repack_id);
grant select, insert, update, delete on public.repack_orders to authenticated;
grant select, insert, update, delete on public.repack_order_items to authenticated;
grant all on public.repack_orders to service_role;
grant all on public.repack_order_items to service_role;
alter table public.repack_orders enable row level security;
alter table public.repack_order_items enable row level security;
drop policy if exists ro_read on public.repack_orders;
create policy ro_read on public.repack_orders for select using (true);
drop policy if exists ro_write on public.repack_orders;
create policy ro_write on public.repack_orders for all
  using (my_factory_code()='HEAD_OFFICE' or factory_code=any(my_factory_codes()) or created_by=auth.uid()) with check (true);
drop policy if exists roi_read on public.repack_order_items;
create policy roi_read on public.repack_order_items for select using (true);
drop policy if exists roi_write on public.repack_order_items;
create policy roi_write on public.repack_order_items for all using (true) with check (true);

create or replace function public.create_repack_order(p_factory text, p_customer text, p_delivery_date text, p_items jsonb)
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_id uuid; v_no text; r jsonb; v_qty numeric; v_item public.items; v_count int := 0; v_name text;
begin
  if coalesce(btrim(p_factory), '') = '' then raise exception 'Pick a factory'; end if;
  if not has_perm('sales', 'edit') then raise exception 'Not allowed'; end if;
  v_no := 'RP-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('public.repack_seq')::text, 4, '0');
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.repack_orders (repack_no, factory_code, note, delivery_date, status, created_by, created_by_name)
  values (v_no, p_factory, nullif(btrim(coalesce(p_customer, '')), ''), nullif(p_delivery_date, '')::date, 'Pending', auth.uid(), v_name)
  returning id into v_id;
  for r in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_qty := coalesce((r->>'qty')::numeric, 0);
    if v_qty <= 0 then continue; end if;
    select * into v_item from public.items where code = r->>'code' limit 1;
    insert into public.repack_order_items (repack_id, item_code, description, unit, qty)
    values (v_id, coalesce(v_item.code, r->>'code'), coalesce(v_item.description, r->>'description'), coalesce(v_item.unit, r->>'unit'), v_qty);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then delete from public.repack_orders where id = v_id; raise exception 'Add at least one item with a quantity'; end if;
  return v_id;
end; $function$;
grant execute on function public.create_repack_order(text, text, text, jsonb) to authenticated;

create or replace function public.approve_repack_order(p_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_o public.repack_orders; r record; v_b uuid; v_name text; v_count int := 0;
begin
  select * into v_o from public.repack_orders where id = p_id and status = 'Pending';
  if not found then raise exception 'Not a pending repack order'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_o.factory_code = any (my_factory_codes())) then
    raise exception 'Only the chosen factory (%) can approve this repack', v_o.factory_code; end if;
  for r in select * from public.repack_order_items where repack_id = p_id loop
    if coalesce(r.qty, 0) <= 0 then continue; end if;
    insert into public.production_batches (batch_no, item_code, description, delivery_date, factory_code, total_quantity, status, run_mode)
    values ('PB-' || lpad(nextval('public.production_batch_seq')::text, 5, '0'), r.item_code, r.description, v_o.delivery_date, v_o.factory_code, r.qty, 'Planned', 'manual')
    returning id into v_b;
    insert into public.production_batch_items (batch_id, so_number, customer_name, quantity, factory_code)
    values (v_b, v_o.repack_no, 'WAREHOUSE' || case when nullif(btrim(coalesce(v_o.note, '')), '') is not null then ' · ' || v_o.note else '' end, r.qty, v_o.factory_code);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then raise exception 'This repack order has no items'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.repack_orders set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end; $function$;
grant execute on function public.approve_repack_order(uuid) to authenticated;

create or replace function public.reject_repack_order(p_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_name text;
begin
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.repack_orders set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
   where id = p_id and status = 'Pending'
     and (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or created_by = auth.uid());
end; $function$;
grant execute on function public.reject_repack_order(uuid) to authenticated;

-- ─── 2) Grinding: actual qty added, machine, grind-by, outputs ───────────────
alter table public.grinding_materials add column if not exists actual_qty numeric;
alter table public.grinding_records add column if not exists machine_id text;
alter table public.grinding_records add column if not exists grind_by text;

create table if not exists public.grinding_outputs (
  id uuid primary key default gen_random_uuid(),
  grinding_record_id uuid not null references public.grinding_records(id) on delete cascade,
  factory_code text, item text, batch_no text, exp_date date, qty numeric,
  created_at timestamptz not null default now()
);
create index if not exists grinding_outputs_record on public.grinding_outputs (grinding_record_id);
grant select, insert, update, delete on public.grinding_outputs to authenticated;
alter table public.grinding_outputs enable row level security;
drop policy if exists go_read on public.grinding_outputs;
create policy go_read on public.grinding_outputs for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));
drop policy if exists go_write on public.grinding_outputs;
create policy go_write on public.grinding_outputs for all
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()))
  with check (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()));

-- ─── 3) Sales orders: viewable by everyone (GCH stays open + customer filter) ─
drop policy if exists sol_gch_view on public.sales_order_lines;
create policy sol_gch_view on public.sales_order_lines for select to authenticated
  using (coalesce(location_code, '') ilike 'GCH%' or coalesce(customer_name, '') ilike 'GCH%');
drop policy if exists si_gch_view on public.sales_imports;
create policy si_gch_view on public.sales_imports for select to authenticated
  using (exists (select 1 from public.sales_order_lines l
                 where l.import_id = sales_imports.id
                   and (coalesce(l.location_code, '') ilike 'GCH%' or coalesce(l.customer_name, '') ilike 'GCH%')));

drop policy if exists sol_all_view on public.sales_order_lines;
create policy sol_all_view on public.sales_order_lines for select to authenticated using (true);
drop policy if exists si_all_view on public.sales_imports;
create policy si_all_view on public.sales_imports for select to authenticated using (true);

-- ─── 4) Set the packing factory directly on an open sales line ───────────────
create or replace function public.assign_packing_factory(p_line_id uuid, p_factory text)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_line public.sales_order_lines;
begin
  select * into v_line from public.sales_order_lines where id = p_line_id;
  if not found then raise exception 'Line not found'; end if;
  if not has_perm('sales', 'edit') then raise exception 'Not allowed'; end if;
  if coalesce(v_line.factory_code, '') <> '' and exists (
       select 1 from public.document_confirmations dc
        where dc.import_id = v_line.import_id and dc.factory_code = v_line.factory_code)
  then raise exception 'Already confirmed — change needs Head Office approval'; end if;
  update public.sales_order_lines set factory_code = nullif(btrim(p_factory), '') where id = p_line_id;
end; $function$;
grant execute on function public.assign_packing_factory(uuid, text) to authenticated;

-- ─── 5) Edit unconfirmed sales line (non-HO: Location & Delivery Date only) ──
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

-- ─── 6) Extra-for-stock material requests (single correct overload) ──────────
do $$ declare r record; begin
  for r in select oid::regprocedure as sig from pg_proc where proname = 'raise_material_request_ext'
  loop execute 'drop function ' || r.sig; end loop;
end $$;
create function public.raise_material_request_ext(p_batch_ids uuid[], p_items jsonb, p_extra numeric, p_note text)
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare
  v_item text; v_factory text; v_mode text; v_req uuid; v_no text; v_count int := 0;
  v_total numeric; r jsonb; v_it public.items; v_qty numeric; v_parent uuid; c record; v_short numeric; v_reqd numeric;
begin
  select item_code, factory_code, coalesce(run_mode, 'auto') into v_item, v_factory, v_mode
    from public.production_batches where id = p_batch_ids[1];
  if v_item is null then raise exception 'Batch not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and v_factory <> all(my_factory_codes()) then raise exception 'Not allowed for this factory'; end if;
  if exists (select 1 from public.production_batches where id = any(p_batch_ids)
             and (item_code <> v_item or factory_code <> v_factory or material_request_id is not null)) then
    raise exception 'All batches must be the same item & factory and not already requested';
  end if;
  v_no := 'MR-' || lpad(nextval('public.material_request_seq')::text, 5, '0');
  insert into public.material_requests (request_no, batch_id, factory_code, status, extra_qty, note)
  values (v_no, p_batch_ids[1], v_factory, 'Open', coalesce(p_extra, 0), p_note) returning id into v_req;
  if coalesce(p_note, '') like 'Ad-hoc%' then
    for r in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
      v_qty := coalesce((r->>'qty')::numeric, 0);
      if v_qty <= 0 then continue; end if;
      select * into v_it from public.items where code = r->>'code' limit 1;
      insert into public.material_request_items
        (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
      values (v_req, v_it.id, coalesce(v_it.code, r->>'code'), coalesce(v_it.description, r->>'description'),
              coalesce(v_it.unit, r->>'unit'), v_qty, 0, v_qty, v_qty, 0, v_factory);
      v_count := v_count + 1;
    end loop;
  else
    select coalesce(sum(total_quantity), 0) into v_total from public.production_batches where id = any(p_batch_ids);
    v_total := v_total + coalesce(p_extra, 0);
    select id into v_parent from public.items where code = v_item limit 1;
    if v_parent is null then raise exception 'Item % not found in Items Master', v_item; end if;
    for c in
      select bc.component_item_id as item_id, it.code, it.description, it.unit, bc.apply_allowance,
             bc.quantity * v_total as required_qty, coalesce(s.quantity, 0) as stock_qty
      from public.bom_components bc join public.items it on it.id = bc.component_item_id
      left join public.item_stock s on s.item_id = bc.component_item_id and s.factory_code = v_factory
      where bc.parent_item_id = v_parent
        and (bc.use_mode = 'any' or bc.use_mode = v_mode)
    loop
      v_short := c.required_qty - c.stock_qty;
      if v_short > 0 then
        v_reqd := case when c.apply_allowance then ceil(v_short * 1.1) else v_short end;
        insert into public.material_request_items
          (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
        values (v_req, c.item_id, c.code, c.description, c.unit, c.required_qty, c.stock_qty, v_short, v_reqd, 0, v_factory);
        v_count := v_count + 1;
      end if;
    end loop;
  end if;
  if v_count = 0 then delete from public.material_requests where id = v_req; raise exception 'Nothing to request — enough stock on hand, or no materials.'; end if;
  update public.production_batches set status = case when status = 'Planned' then 'Requested' else status end, material_request_id = v_req where id = any(p_batch_ids);
  return v_req;
end; $function$;
grant execute on function public.raise_material_request_ext(uuid[], jsonb, numeric, text) to authenticated;

-- ─── 7) Auto-refresh keeps extra-for-stock and skips ad-hoc requests ─────────
create or replace function public.refresh_one_open_request(p_request_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_req public.material_requests; v_batch public.production_batches; v_parent uuid; v_count int := 0; c record; v_short numeric; v_reqd numeric; v_total numeric;
begin
  select * into v_req from public.material_requests where id = p_request_id;
  if not found or v_req.status <> 'Open' then return; end if;
  if coalesce(v_req.note, '') like 'Ad-hoc%' then return; end if;
  select * into v_batch from public.production_batches where id = v_req.batch_id;
  if not found then return; end if;
  select coalesce(sum(total_quantity), 0) into v_total from public.production_batches where material_request_id = p_request_id;
  if v_total = 0 then v_total := v_batch.total_quantity; end if;
  v_total := v_total + coalesce(v_req.extra_qty, 0);
  select id into v_parent from public.items where code = v_batch.item_code limit 1;
  delete from public.material_request_items where request_id = p_request_id;
  if v_parent is not null then
    for c in
      select bc.component_item_id as item_id, it.code, it.description, it.unit, bc.apply_allowance,
             bc.quantity * v_total as required_qty, coalesce(s.quantity,0) as stock_qty
      from public.bom_components bc join public.items it on it.id = bc.component_item_id
      left join public.item_stock s on s.item_id = bc.component_item_id and s.factory_code = v_batch.factory_code
      where bc.parent_item_id = v_parent
        and (bc.use_mode = 'any' or bc.use_mode = coalesce(v_batch.run_mode, 'auto'))
    loop
      v_short := c.required_qty - c.stock_qty;
      if v_short > 0 then
        v_reqd := case when c.apply_allowance then ceil(v_short * 1.1) else v_short end;
        insert into public.material_request_items
          (request_id, item_id, item_code, description, unit, required_qty, stock_qty, shortfall_qty, requested_qty, received_qty, factory_code)
        values (p_request_id, c.item_id, c.code, c.description, c.unit, c.required_qty, c.stock_qty, v_short, v_reqd, 0, v_batch.factory_code);
        v_count := v_count + 1;
      end if;
    end loop;
  end if;
  if v_count = 0 then delete from public.material_requests where id = p_request_id; end if;
end; $function$;

-- ─── 8) Change a confirmed line's factory (HO approval) + material transfer ──
create table if not exists public.factory_change_requests (
  id uuid primary key default gen_random_uuid(),
  line_id uuid not null, import_id uuid, from_factory text, to_factory text not null,
  reason text, status text not null default 'Pending',
  requested_by uuid, requested_by_name text, reviewed_by uuid, reviewed_by_name text,
  reviewed_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists fcr_status on public.factory_change_requests (status, created_at);
grant select, insert on public.factory_change_requests to authenticated;
grant all on public.factory_change_requests to service_role;
alter table public.factory_change_requests enable row level security;
drop policy if exists fcr_read on public.factory_change_requests;
create policy fcr_read on public.factory_change_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or from_factory = any (my_factory_codes()) or to_factory = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists fcr_insert on public.factory_change_requests;
create policy fcr_insert on public.factory_change_requests for insert
  with check (requested_by = auth.uid() and has_perm('sales', 'edit'));

alter table public.factory_change_requests add column if not exists transfer boolean not null default false;
alter table public.factory_change_requests add column if not exists transfer_items jsonb;

create table if not exists public.material_transfers (
  id uuid primary key default gen_random_uuid(),
  from_factory text not null, to_factory text not null,
  line_id uuid, import_id uuid, reason text, status text not null default 'Pending',
  created_by uuid, created_by_name text, created_at timestamptz not null default now(),
  sent_by uuid, sent_by_name text, sent_at timestamptz,
  received_by uuid, received_by_name text, received_at timestamptz
);
create table if not exists public.material_transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.material_transfers(id) on delete cascade,
  item_code text, description text, unit text, qty numeric
);
create index if not exists mti_transfer on public.material_transfer_items(transfer_id);
grant select, insert, update, delete on public.material_transfers to authenticated;
grant select, insert, update, delete on public.material_transfer_items to authenticated;
grant all on public.material_transfers to service_role;
grant all on public.material_transfer_items to service_role;
alter table public.material_transfers enable row level security;
alter table public.material_transfer_items enable row level security;
drop policy if exists mt_read on public.material_transfers;
create policy mt_read on public.material_transfers for select
  using (my_factory_code()='HEAD_OFFICE' or from_factory=any(my_factory_codes()) or to_factory=any(my_factory_codes()));
drop policy if exists mt_write on public.material_transfers;
create policy mt_write on public.material_transfers for all
  using (my_factory_code()='HEAD_OFFICE' or from_factory=any(my_factory_codes()) or to_factory=any(my_factory_codes())) with check (true);
drop policy if exists mti_read on public.material_transfer_items;
create policy mti_read on public.material_transfer_items for select
  using (exists (select 1 from public.material_transfers t where t.id=transfer_id and (my_factory_code()='HEAD_OFFICE' or t.from_factory=any(my_factory_codes()) or t.to_factory=any(my_factory_codes()))));
drop policy if exists mti_write on public.material_transfer_items;
create policy mti_write on public.material_transfer_items for all using (true) with check (true);

drop function if exists public.request_factory_change(uuid, text, text);
create or replace function public.request_factory_change(
  p_line_id uuid, p_to_factory text, p_reason text, p_transfer boolean default false, p_items jsonb default null)
 returns uuid language plpgsql security definer set search_path to 'public' as $function$
declare v_line public.sales_order_lines; v_id uuid; v_name text;
begin
  if not has_perm('sales', 'edit') then raise exception 'Not allowed'; end if;
  if coalesce(btrim(p_to_factory), '') = '' then raise exception 'Pick a factory to move to'; end if;
  select * into v_line from public.sales_order_lines where id = p_line_id;
  if not found then raise exception 'Line not found'; end if;
  if p_to_factory = coalesce(v_line.factory_code, '') then raise exception 'That is already the line''s factory'; end if;
  if exists (select 1 from public.factory_change_requests where line_id = p_line_id and status = 'Pending') then
    raise exception 'A factory-change request for this line is already waiting for Head Office'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.factory_change_requests (line_id, import_id, from_factory, to_factory, reason, requested_by, requested_by_name, transfer, transfer_items)
  values (p_line_id, v_line.import_id, v_line.factory_code, p_to_factory, nullif(btrim(p_reason), ''), auth.uid(), v_name,
          coalesce(p_transfer, false), case when coalesce(p_transfer,false) then p_items else null end)
  returning id into v_id;
  return v_id;
end; $function$;
grant execute on function public.request_factory_change(uuid, text, text, boolean, jsonb) to authenticated;

create or replace function public.approve_factory_change(p_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_req public.factory_change_requests; v_line public.sales_order_lines; v_to text; v_name text; b record; v_recv numeric; v_cnt int;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into v_req from public.factory_change_requests where id = p_id and status = 'Pending';
  if not found then raise exception 'Not a pending request'; end if;
  select * into v_line from public.sales_order_lines where id = v_req.line_id;
  if not found then raise exception 'That line no longer exists'; end if;
  v_to := v_req.to_factory;
  for b in
    select pb.* from public.production_batches pb
     where pb.item_code = v_line.item_code
       and exists (select 1 from public.production_batch_items pbi where pbi.batch_id = pb.id and pbi.so_number = v_line.so_number)
  loop
    select count(*) into v_cnt from public.production_batch_items where batch_id = b.id;
    if v_cnt > 1 then raise exception 'Batch % is combined with other orders — un-combine it first, then approve', b.batch_no; end if;
    if b.material_request_id is not null then
      select coalesce(sum(received_qty), 0) into v_recv from public.material_request_items where request_id = b.material_request_id;
      if v_recv > 0 and not coalesce(v_req.transfer, false) then
        raise exception 'Batch % already has received materials — tick "transfer materials" on the request, or move it manually', b.batch_no; end if;
      update public.material_requests set factory_code = v_to where id = b.material_request_id;
      update public.material_request_items set factory_code = v_to where request_id = b.material_request_id;
    end if;
    update public.production_batches set factory_code = v_to where id = b.id;
    if b.material_request_id is not null then perform public.refresh_one_open_request(b.material_request_id); end if;
  end loop;
  update public.sales_order_lines set factory_code = v_to where id = v_req.line_id;
  if coalesce(v_req.transfer, false) and v_req.transfer_items is not null and jsonb_array_length(v_req.transfer_items) > 0 then
    declare v_tr uuid; r jsonb;
    begin
      insert into public.material_transfers (from_factory, to_factory, line_id, import_id, reason, created_by, created_by_name)
      values (v_req.from_factory, v_to, v_req.line_id, v_line.import_id, 'Factory change of ' || v_line.item_code, auth.uid(), (select full_name from public.profiles where id = auth.uid()))
      returning id into v_tr;
      for r in select * from jsonb_array_elements(v_req.transfer_items) loop
        if coalesce((r->>'qty')::numeric, 0) <= 0 then continue; end if;
        insert into public.material_transfer_items (transfer_id, item_code, description, unit, qty)
        values (v_tr, r->>'code', r->>'description', r->>'unit', (r->>'qty')::numeric);
      end loop;
    end;
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.document_confirmations (import_id, factory_code, confirmed_by, confirmed_by_name, confirmed_at)
  select v_line.import_id, v_to, auth.uid(), v_name, now()
   where not exists (select 1 from public.document_confirmations dc where dc.import_id = v_line.import_id and dc.factory_code = v_to);
  if coalesce(v_req.from_factory, '') <> '' and not exists (
       select 1 from public.sales_order_lines sol where sol.import_id = v_line.import_id and sol.factory_code = v_req.from_factory) then
    delete from public.document_confirmations where import_id = v_line.import_id and factory_code = v_req.from_factory;
  end if;
  update public.factory_change_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end; $function$;
grant execute on function public.approve_factory_change(uuid) to authenticated;

create or replace function public.reject_factory_change(p_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.factory_change_requests set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id and status = 'Pending';
end; $function$;
grant execute on function public.reject_factory_change(uuid) to authenticated;

create or replace function public.confirm_transfer_send(p_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_t public.material_transfers; r record; v_item public.items; v_name text;
begin
  select * into v_t from public.material_transfers where id = p_id;
  if not found then raise exception 'Transfer not found'; end if;
  if v_t.status <> 'Pending' then raise exception 'This transfer is already %', v_t.status; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_t.from_factory = any (my_factory_codes())) then
    raise exception 'Only the sending factory (%) can confirm dispatch', v_t.from_factory; end if;
  for r in select * from public.material_transfer_items where transfer_id = p_id loop
    select * into v_item from public.items where code = r.item_code limit 1;
    if v_item.id is null then continue; end if;
    update public.item_stock set quantity = greatest(quantity - coalesce(r.qty,0), 0), updated_at = now()
     where item_id = v_item.id and factory_code = v_t.from_factory;
  end loop;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.material_transfers set status = 'Sent', sent_by = auth.uid(), sent_by_name = v_name, sent_at = now() where id = p_id;
end; $function$;
grant execute on function public.confirm_transfer_send(uuid) to authenticated;

create or replace function public.confirm_transfer_receive(p_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_t public.material_transfers; r record; v_item public.items; v_name text;
begin
  select * into v_t from public.material_transfers where id = p_id;
  if not found then raise exception 'Transfer not found'; end if;
  if v_t.status <> 'Sent' then raise exception 'The sending factory must confirm dispatch first (status: %)', v_t.status; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_t.to_factory = any (my_factory_codes())) then
    raise exception 'Only the receiving factory (%) can confirm receipt', v_t.to_factory; end if;
  for r in select * from public.material_transfer_items where transfer_id = p_id loop
    select * into v_item from public.items where code = r.item_code limit 1;
    if v_item.id is null or coalesce(r.qty,0) <= 0 then continue; end if;
    insert into public.stock_lots (item_id, item_code, description, factory_code, batch_no, qty_received, qty_remaining)
    values (v_item.id, v_item.code, v_item.description, v_t.to_factory, 'TRF-' || to_char(now(),'YYMMDD'), r.qty, r.qty);
    insert into public.item_stock (item_id, factory_code, quantity, updated_at)
    values (v_item.id, v_t.to_factory, r.qty, now())
    on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + r.qty, updated_at = now();
  end loop;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.material_transfers set status = 'Received', received_by = auth.uid(), received_by_name = v_name, received_at = now() where id = p_id;
end; $function$;
grant execute on function public.confirm_transfer_receive(uuid) to authenticated;

-- ============================================================================
-- Done. Everything from this session is now live.
-- ============================================================================

-- ─── 9) Delivery schedule (routes + paste-by-SO; TOMORROW DELIVERY tag) ──────
create table if not exists public.delivery_routes (
  id uuid primary key default gen_random_uuid(),
  name text not null, created_by uuid, created_by_name text, created_at timestamptz not null default now()
);
create table if not exists public.delivery_schedule (
  id uuid primary key default gen_random_uuid(),
  so_number text not null, customer_name text, route_id uuid references public.delivery_routes(id) on delete set null,
  delivery_date date, data jsonb, created_by uuid, created_by_name text, created_at timestamptz not null default now()
);
alter table public.delivery_schedule add column if not exists data jsonb;
create index if not exists ds_so on public.delivery_schedule(so_number);
create index if not exists ds_date on public.delivery_schedule(delivery_date);
grant select, insert, update, delete on public.delivery_routes to authenticated;
grant select, insert, update, delete on public.delivery_schedule to authenticated;
grant all on public.delivery_routes to service_role;
grant all on public.delivery_schedule to service_role;
alter table public.delivery_routes enable row level security;
alter table public.delivery_schedule enable row level security;
drop policy if exists dr_read on public.delivery_routes;
create policy dr_read on public.delivery_routes for select using (true);
drop policy if exists dr_write on public.delivery_routes;
create policy dr_write on public.delivery_routes for all using (true) with check (true);
drop policy if exists ds_read on public.delivery_schedule;
create policy ds_read on public.delivery_schedule for select using (true);
drop policy if exists ds_write on public.delivery_schedule;
create policy ds_write on public.delivery_schedule for all using (true) with check (true);

alter table public.delivery_schedule add column if not exists route text;
