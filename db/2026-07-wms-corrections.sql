-- WMS corrections with Head Office approval:
--   * po_line     — fix a wrongly-created PURCHASE-ORDER line (item code / description / qty / unit),
--                   only while the line has not been received yet.
--   * stock_recode— fix stock booked under the WRONG item code: move the qty to the correct code,
--                   keeping the same bin / batch (for goods received under the wrong pack code).
-- Warehouse staff raise a request; a manager (Head Office) approves it to apply. Run in the
-- Supabase SQL editor. Safe to re-run.

create table if not exists public.wms_correction_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                     -- 'po_line' | 'stock_recode'
  po_line_id uuid,
  stock_id uuid,
  old_item_code text, old_description text, old_qty numeric, old_uom text,
  location_code text, batch_no text,
  new_item_code text, new_description text, new_qty numeric, new_uom text,
  reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.wms_correction_requests to authenticated, anon, service_role;
grant update, delete on public.wms_correction_requests to service_role;
alter table public.wms_correction_requests enable row level security;
drop policy if exists wmscorr_read on public.wms_correction_requests;
create policy wmscorr_read on public.wms_correction_requests for select using (has_perm('warehouse','view') or requested_by = auth.uid());
drop policy if exists wmscorr_insert on public.wms_correction_requests;
create policy wmscorr_insert on public.wms_correction_requests for insert with check (requested_by = auth.uid());

-- Request: edit a PO line (only if not yet received).
create or replace function public.request_po_line_edit(
  p_line_id uuid, p_new_item_code text, p_new_description text, p_new_qty numeric, p_new_uom text, p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_l wms_po_lines; v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  select * into v_l from public.wms_po_lines where id = p_line_id;
  if not found then raise exception 'PO line not found'; end if;
  if coalesce(v_l.qty_received, 0) > 0 then raise exception 'This line was already received — correct the stock instead'; end if;
  if exists (select 1 from public.wms_correction_requests where po_line_id = p_line_id and status = 'Pending') then
    raise exception 'A change is already pending for this line'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.wms_correction_requests (kind, po_line_id, old_item_code, old_description, old_qty, old_uom,
    new_item_code, new_description, new_qty, new_uom, reason, requested_by, requested_by_name)
  values ('po_line', p_line_id, v_l.item_code, v_l.description, v_l.quantity, v_l.uom,
    nullif(btrim(p_new_item_code),''), nullif(btrim(p_new_description),''), p_new_qty, nullif(btrim(p_new_uom),''),
    nullif(btrim(p_reason),''), auth.uid(), v_name);
end $$;
grant execute on function public.request_po_line_edit(uuid, text, text, numeric, text, text) to authenticated, anon, service_role;

-- Request: re-code a stock line to the correct item.
create or replace function public.request_stock_recode(p_stock_id uuid, p_new_item_code text, p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_s wms_stock; v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  select * into v_s from public.wms_stock where id = p_stock_id;
  if not found then raise exception 'Stock line not found'; end if;
  if nullif(btrim(p_new_item_code),'') is null then raise exception 'Enter the correct item code'; end if;
  if upper(btrim(p_new_item_code)) = upper(v_s.item_code) then raise exception 'That is already the item code'; end if;
  if exists (select 1 from public.wms_correction_requests where stock_id = p_stock_id and status = 'Pending') then
    raise exception 'A change is already pending for this stock line'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.wms_correction_requests (kind, stock_id, old_item_code, old_description, old_qty, location_code, batch_no,
    new_item_code, reason, requested_by, requested_by_name)
  values ('stock_recode', p_stock_id, v_s.item_code, v_s.description, v_s.quantity, v_s.location_code, v_s.batch_no,
    upper(btrim(p_new_item_code)), nullif(btrim(p_reason),''), auth.uid(), v_name);
end $$;
grant execute on function public.request_stock_recode(uuid, text, text) to authenticated, anon, service_role;

-- Approve (Head Office): apply the correction.
create or replace function public.approve_wms_correction(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare r wms_correction_requests; v_name text; v_new_id uuid; v_desc text; v_uom text; v_s wms_stock; v_exists uuid;
begin
  if not is_ho_or_admin() then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.wms_correction_requests where id = p_id;
  if not found then raise exception 'Request not found'; end if;
  if r.status <> 'Pending' then raise exception 'This request was already handled'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  if r.kind = 'po_line' then
    select id, description, unit into v_new_id, v_desc, v_uom from items where code = r.new_item_code;
    update public.wms_po_lines
      set item_code = coalesce(r.new_item_code, item_code), item_id = coalesce(v_new_id, item_id),
          description = coalesce(r.new_description, v_desc, description),
          quantity = coalesce(r.new_qty, quantity), uom = coalesce(r.new_uom, v_uom, uom)
      where id = r.po_line_id and coalesce(qty_received,0) = 0;
    if not found then raise exception 'Line not found or already received'; end if;

  elsif r.kind = 'stock_recode' then
    select * into v_s from public.wms_stock where id = r.stock_id;
    if not found then raise exception 'Stock line no longer exists'; end if;
    select id, description, unit into v_new_id, v_desc, v_uom from items where code = r.new_item_code;
    -- Merge into an existing row for the new code in the same bin/batch, or just rename this row.
    select id into v_exists from public.wms_stock
      where warehouse_code = v_s.warehouse_code and item_code = r.new_item_code and location_id = v_s.location_id and batch_no = v_s.batch_no and id <> v_s.id;
    if v_exists is not null then
      update public.wms_stock set quantity = quantity + v_s.quantity, updated_at = now() where id = v_exists;
      delete from public.wms_stock where id = v_s.id;
    else
      update public.wms_stock set item_code = r.new_item_code, item_id = coalesce(v_new_id, item_id),
        description = coalesce(v_desc, description), updated_at = now() where id = v_s.id;
    end if;
    -- Audit: out of the old code, in to the new code (same bin).
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values (v_s.warehouse_code, 'adjust', v_s.item_id, v_s.item_code, v_s.description, v_s.location_id, v_s.location_code, v_s.batch_no, v_s.exp_date, v_s.quantity, 'Re-code → ' || r.new_item_code, auth.uid(), v_name);
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values (v_s.warehouse_code, 'adjust', v_new_id, r.new_item_code, coalesce(v_desc, v_s.description), v_s.location_id, v_s.location_code, v_s.batch_no, v_s.exp_date, v_s.quantity, 'Re-code ← ' || v_s.item_code, auth.uid(), v_name);
  else
    raise exception 'Unknown correction kind';
  end if;

  update public.wms_correction_requests set status='Approved', reviewed_by=auth.uid(), reviewed_by_name=v_name, reviewed_at=now() where id = p_id;
end $$;
grant execute on function public.approve_wms_correction(uuid) to authenticated, anon, service_role;

create or replace function public.reject_wms_correction(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not is_ho_or_admin() then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.wms_correction_requests set status='Rejected', reviewed_by=auth.uid(), reviewed_by_name=v_name, reviewed_at=now()
    where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_wms_correction(uuid) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
