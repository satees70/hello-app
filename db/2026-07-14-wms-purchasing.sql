-- ============================================================
-- WMS: Supplier Purchase Orders + Goods Received (GRN)
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- Builds on the EXISTING wms_stock / wms_stock_moves — no new stock store.
-- ============================================================

-- Private bucket for PO PDFs + goods-in photos.
insert into storage.buckets (id, name, public) values ('wms-grn','wms-grn',false) on conflict (id) do nothing;
drop policy if exists wms_grn_read on storage.objects;
drop policy if exists wms_grn_write on storage.objects;
drop policy if exists wms_grn_del on storage.objects;
create policy wms_grn_read  on storage.objects for select to authenticated using (bucket_id='wms-grn' and has_perm('warehouse','view'));
create policy wms_grn_write on storage.objects for insert to authenticated with check (bucket_id='wms-grn' and has_perm('warehouse','edit'));
create policy wms_grn_del   on storage.objects for delete to authenticated using (bucket_id='wms-grn' and has_perm('warehouse','edit'));

-- Purchase order header + lines.
create table if not exists public.wms_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  warehouse_code text not null default '8BT',
  source text not null default 'pdf' check (source in ('pdf','sql_account','manual')),
  po_number text, supplier_name text, order_date text, expected_date text,
  file_name text, file_path text,
  status text not null default 'Processing'
    check (status in ('Processing','Open','Partially Received','Fulfilled','Cancelled','Error')),
  error_message text, created_by uuid, created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists wms_po_status on public.wms_purchase_orders(status, created_at desc);

create table if not exists public.wms_po_lines (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references public.wms_purchase_orders(id) on delete cascade,
  line_no int, item_id uuid references public.items(id),
  item_code text not null, description text,
  quantity numeric not null default 0, qty_received numeric not null default 0, uom text,
  created_at timestamptz not null default now()
);
create index if not exists wms_po_lines_po on public.wms_po_lines(po_id);

-- Goods Received Note (one per delivery received against a PO) + its lines.
create sequence if not exists wms_grn_seq;
create table if not exists public.wms_grns (
  id uuid primary key default gen_random_uuid(),
  warehouse_code text not null default '8BT',
  grn_no text, po_id uuid references public.wms_purchase_orders(id) on delete set null,
  supplier_name text, received_at timestamptz not null default now(),
  received_by uuid, received_by_name text, notes text,
  created_at timestamptz not null default now()
);
create table if not exists public.wms_grn_lines (
  id uuid primary key default gen_random_uuid(),
  grn_id uuid not null references public.wms_grns(id) on delete cascade,
  po_line_id uuid references public.wms_po_lines(id) on delete set null,
  item_id uuid references public.items(id),
  item_code text not null, description text,
  qty_received numeric not null default 0, batch_no text not null default '', exp_date date,
  qc_status text not null default 'pass' check (qc_status in ('pass','fail')),
  qc_note text, photo_path text,
  created_at timestamptz not null default now()
);
create index if not exists wms_grn_lines_grn on public.wms_grn_lines(grn_id);

-- The GOODS-IN staging bin: received stock lands here = "pending putaway".
insert into public.wms_locations (warehouse_code, category, location_type, code, aisle, sql_location, label, active)
values ('8BT','Stock','STAGE','GOODS-IN','GOODS-IN','8BT/Stock/STAGE/GOODS-IN','Goods-in / pending putaway', true)
on conflict (warehouse_code, code) do nothing;

-- Grants + RLS for the four tables.
grant select, insert, update, delete on
  public.wms_purchase_orders, public.wms_po_lines, public.wms_grns, public.wms_grn_lines
  to authenticated, anon, service_role;
grant usage on sequence wms_grn_seq to authenticated, anon, service_role;
do $$
declare t text;
begin
  foreach t in array array['wms_purchase_orders','wms_po_lines','wms_grns','wms_grn_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (has_perm(''warehouse'',''view''))', t, t);
    execute format('create policy %I_write on public.%I for all using (has_perm(''warehouse'',''edit'')) with check (has_perm(''warehouse'',''edit''))', t, t);
  end loop;
end $$;

-- Start a Goods Received Note against a PO (assigns a GRN number). Returns its id.
create or replace function public.wms_start_grn(p_po_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_supplier text; v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to receive goods'; end if;
  select supplier_name into v_supplier from wms_purchase_orders where id = p_po_id;
  select full_name into v_name from profiles where id = auth.uid();
  insert into wms_grns (grn_no, po_id, supplier_name, received_by, received_by_name)
  values ('GRN-' || lpad(nextval('wms_grn_seq')::text, 6, '0'), p_po_id, v_supplier, auth.uid(), v_name)
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.wms_start_grn(uuid) to authenticated, anon, service_role;

-- Receive one delivered line: record it, book the stock into the GOODS-IN staging
-- bin (the ONE shared stock truth), log a 'receipt' move, reduce the PO outstanding,
-- and update the PO status (Open → Partially Received → Fulfilled).
create or replace function public.wms_receive_line(
  p_grn_id uuid, p_po_line_id uuid, p_item_code text, p_qty numeric,
  p_batch text, p_exp_date date, p_qc text, p_qc_note text, p_photo_path text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item_id uuid; v_desc text; v_uom text; v_stage uuid; v_name text; v_po_id uuid;
  v_batch text := coalesce(p_batch,'');
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to receive goods'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  select id, description, unit into v_item_id, v_desc, v_uom from items where code = p_item_code;
  select id into v_stage from wms_locations where warehouse_code='8BT' and code='GOODS-IN';
  if v_stage is null then raise exception 'GOODS-IN staging bin is missing — run the WMS purchasing migration'; end if;
  select full_name into v_name from profiles where id = auth.uid();

  insert into wms_grn_lines (grn_id, po_line_id, item_id, item_code, description, qty_received, batch_no, exp_date, qc_status, qc_note, photo_path)
  values (p_grn_id, p_po_line_id, v_item_id, p_item_code, v_desc, p_qty, v_batch, p_exp_date, coalesce(p_qc,'pass'), p_qc_note, p_photo_path);

  -- add to the ONE stock table, at GOODS-IN
  insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', v_item_id, p_item_code, v_desc, v_stage, 'GOODS-IN', v_batch, p_exp_date, p_qty, v_uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
  do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();

  insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'receipt', v_item_id, p_item_code, v_desc, v_stage, 'GOODS-IN', v_batch, p_exp_date, p_qty,
    (select grn_no from wms_grns where id = p_grn_id), auth.uid(), v_name);

  if p_po_line_id is not null then
    update wms_po_lines set qty_received = qty_received + p_qty where id = p_po_line_id;
    select po_id into v_po_id from wms_po_lines where id = p_po_line_id;
  else
    select po_id into v_po_id from wms_grns where id = p_grn_id;
  end if;

  if v_po_id is not null then
    update wms_purchase_orders o set status = case
        when o.status = 'Cancelled' then o.status
        when not exists (select 1 from wms_po_lines pl where pl.po_id = o.id and pl.qty_received < pl.quantity) then 'Fulfilled'
        when exists (select 1 from wms_po_lines pl where pl.po_id = o.id and pl.qty_received > 0) then 'Partially Received'
        else 'Open' end
      where o.id = v_po_id;
  end if;
end $$;
grant execute on function public.wms_receive_line(uuid, uuid, text, numeric, text, date, text, text, text) to authenticated, anon, service_role;

-- Picking must NOT pull from the GOODS-IN staging bin (not on a shelf yet).
-- Re-defines wms_pick_line to exclude location_type 'STAGE'.
create or replace function public.wms_pick_line(p_line_id uuid, p_qty numeric, p_reference text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_line wms_order_lines; v_order wms_orders; v_name text;
  v_need numeric; v_picked numeric := 0; v_take numeric; v_allocs jsonb := '[]'::jsonb; r record;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to pick warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Pick quantity must be greater than zero'; end if;
  select * into v_line from wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from wms_orders where id = v_line.order_id;
  select full_name into v_name from profiles where id = auth.uid();
  v_need := p_qty;
  for r in
    select s.id, s.location_id, s.location_code, s.batch_no, s.exp_date, s.quantity
    from wms_stock s join wms_locations l on l.id = s.location_id
    where s.warehouse_code = '8BT' and s.item_code = v_line.item_code and s.quantity > 0
      and l.location_type <> 'STAGE'
    order by (l.location_type <> 'SL'), s.exp_date asc nulls last, coalesce(l.pick_sequence, 999999), s.location_code
  loop
    exit when v_need <= 0;
    v_take := least(r.quantity, v_need);
    update wms_stock set quantity = quantity - v_take, updated_at = now() where id = r.id;
    delete from wms_stock where id = r.id and quantity <= 0;
    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'pick', v_line.item_id, v_line.item_code, v_line.description,
      r.location_id, r.location_code, r.batch_no, r.exp_date, v_take, coalesce(p_reference, v_order.order_no), auth.uid(), v_name);
    v_allocs := v_allocs || jsonb_build_object('bin', r.location_code, 'batch', r.batch_no, 'exp', r.exp_date, 'qty', v_take);
    v_picked := v_picked + v_take; v_need := v_need - v_take;
  end loop;
  update wms_order_lines set qty_picked = qty_picked + v_picked where id = p_line_id;
  update wms_orders o set status = case
      when not exists (select 1 from wms_order_lines wl where wl.order_id = o.id and wl.qty_picked < wl.quantity) then 'Picked'
      when exists (select 1 from wms_order_lines wl where wl.order_id = o.id and wl.qty_picked > 0) then 'Picking'
      else o.status end
    where o.id = v_line.order_id;
  return jsonb_build_object('picked', v_picked, 'shortfall', greatest(v_need, 0), 'allocations', v_allocs);
end $$;
grant execute on function public.wms_pick_line(uuid, numeric, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
