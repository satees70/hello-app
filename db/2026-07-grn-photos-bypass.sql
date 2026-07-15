-- PO receiving: capture the WEIGHT as a photo (staff photographs the scale), and require three
-- photos — product, bag, weight — before a line can be received. If a photo can't be taken, staff
-- can request a BYPASS which a manager (Head Office) approves; an approved bypass lets that line be
-- received without the photos.
--
-- Depends on db/2026-07-grn-bag-weight.sql. Run in the Supabase SQL editor. Safe to re-run.

alter table public.wms_grn_lines add column if not exists weight_photo_path text;
alter table public.wms_grn_lines add column if not exists photo_bypass boolean not null default false;

-- Bypass request envelope (Head Office / manager approves).
create table if not exists public.grn_bypass_requests (
  id uuid primary key default gen_random_uuid(),
  po_id uuid, po_line_id uuid, item_code text, description text, factory_code text,
  reason text, status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  consumed_at timestamptz, created_at timestamptz not null default now()
);
grant select, insert on public.grn_bypass_requests to authenticated, anon, service_role;
grant update, delete on public.grn_bypass_requests to service_role;
alter table public.grn_bypass_requests enable row level security;
drop policy if exists grnbp_read on public.grn_bypass_requests;
create policy grnbp_read on public.grn_bypass_requests for select using (has_perm('warehouse','view') or requested_by = auth.uid());
drop policy if exists grnbp_insert on public.grn_bypass_requests;
create policy grnbp_insert on public.grn_bypass_requests for insert with check (requested_by = auth.uid());

create or replace function public.request_grn_bypass(p_po_line_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_item text; v_desc text; v_po uuid;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  if p_po_line_id is null then raise exception 'No line to bypass'; end if;
  if exists (select 1 from public.grn_bypass_requests where po_line_id = p_po_line_id and status in ('Pending','Approved') and consumed_at is null) then
    raise exception 'A photo bypass is already pending or approved for this line'; end if;
  select item_code, description, po_id into v_item, v_desc, v_po from public.wms_po_lines where id = p_po_line_id;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.grn_bypass_requests (po_id, po_line_id, item_code, description, reason, requested_by, requested_by_name)
  values (v_po, p_po_line_id, v_item, v_desc, nullif(p_reason,''), auth.uid(), v_name);
end $$;
grant execute on function public.request_grn_bypass(uuid, text) to authenticated, anon, service_role;

create or replace function public.approve_grn_bypass(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.grn_bypass_requests set status='Approved', reviewed_by=auth.uid(), reviewed_by_name=v_name, reviewed_at=now()
    where id = p_id and status='Pending';
end $$;
grant execute on function public.approve_grn_bypass(uuid) to authenticated;

create or replace function public.reject_grn_bypass(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.grn_bypass_requests set status='Rejected', reviewed_by=auth.uid(), reviewed_by_name=v_name, reviewed_at=now()
    where id = p_id and status='Pending';
end $$;
grant execute on function public.reject_grn_bypass(uuid) to authenticated;

-- Receive: needs the three photos, OR an approved (unconsumed) photo bypass for the line.
drop function if exists public.wms_receive_line(uuid, uuid, text, numeric, text, date, text, text, text, text, numeric);
drop function if exists public.wms_receive_line(uuid, uuid, text, numeric, text, date, text, text, text, text, text);
create or replace function public.wms_receive_line(
  p_grn_id uuid, p_po_line_id uuid, p_item_code text, p_qty numeric,
  p_batch text, p_exp_date date, p_qc text, p_qc_note text, p_photo_path text,
  p_bag_photo_path text default null, p_weight_photo_path text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item_id uuid; v_desc text; v_uom text; v_stage uuid; v_name text; v_po_id uuid;
  v_batch text := coalesce(p_batch,''); v_has_photos boolean; v_bypass uuid;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to receive goods'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  v_has_photos := coalesce(p_photo_path,'') <> '' and coalesce(p_bag_photo_path,'') <> '' and coalesce(p_weight_photo_path,'') <> '';
  if not v_has_photos then
    select id into v_bypass from public.grn_bypass_requests
      where po_line_id = p_po_line_id and status='Approved' and consumed_at is null order by reviewed_at limit 1;
    if v_bypass is null then raise exception 'Product, bag and weight photos are required — or get a photo bypass approved'; end if;
    update public.grn_bypass_requests set consumed_at = now() where id = v_bypass;
  end if;
  select id, description, unit into v_item_id, v_desc, v_uom from items where code = p_item_code;
  select id into v_stage from wms_locations where warehouse_code='8BT' and code='GOODS-IN';
  if v_stage is null then raise exception 'GOODS-IN staging bin is missing — run the WMS purchasing migration'; end if;
  select full_name into v_name from profiles where id = auth.uid();

  insert into wms_grn_lines (grn_id, po_line_id, item_id, item_code, description, qty_received, batch_no, exp_date, qc_status, qc_note, photo_path, bag_photo_path, weight_photo_path, photo_bypass)
  values (p_grn_id, p_po_line_id, v_item_id, p_item_code, v_desc, p_qty, v_batch, p_exp_date, coalesce(p_qc,'pass'), p_qc_note, nullif(p_photo_path,''), nullif(p_bag_photo_path,''), nullif(p_weight_photo_path,''), not v_has_photos);

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
grant execute on function public.wms_receive_line(uuid, uuid, text, numeric, text, date, text, text, text, text, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
