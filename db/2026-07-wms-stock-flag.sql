-- Broaden the Putaway flag: warehouse can flag a wrong ITEM NAME and/or QUANTITY (as well as
-- the batch) on a just-received stock line, so Head Office is notified to revise it. It rides the
-- SAME WMS Approvals envelope as the other corrections (wms_correction_requests, kind 'stock_flag').
--
-- On approve: if the flagger gave a corrected BATCH, the stock line's batch is fixed (safe, it's
-- only a label). A wrong ITEM or QUANTITY is surfaced to the office as the suggested correction —
-- the office revises the source document (and can re-upload the amended PDF on the PO) rather than
-- the app silently changing stock. Approving simply clears the flag once handled.
-- Run in the Supabase SQL editor. Safe to re-run.

-- Remember which fields the warehouse flagged (e.g. 'item,qty,batch') alongside the suggested values.
alter table public.wms_correction_requests add column if not exists flag_fields text;

create or replace function public.flag_stock_issue(
  p_stock_id uuid, p_fields text, p_correct_item text default null, p_correct_qty numeric default null,
  p_correct_batch text default null, p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_s wms_stock; v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  select * into v_s from public.wms_stock where id = p_stock_id;
  if not found then raise exception 'Stock line not found'; end if;
  if nullif(btrim(p_fields), '') is null then raise exception 'Choose what looks wrong (item, quantity or batch)'; end if;
  if exists (select 1 from public.wms_correction_requests where stock_id = p_stock_id and kind in ('batch_flag','stock_flag') and status = 'Pending') then
    raise exception 'This stock line is already flagged and waiting for the office'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.wms_correction_requests (kind, stock_id, old_item_code, old_description, old_qty, location_code, batch_no,
    new_description, new_qty, new_batch, flag_fields, reason, requested_by, requested_by_name)
  values ('stock_flag', p_stock_id, v_s.item_code, v_s.description, v_s.quantity, v_s.location_code, v_s.batch_no,
    nullif(btrim(p_correct_item),''), p_correct_qty, nullif(btrim(p_correct_batch),''), btrim(p_fields),
    nullif(btrim(p_reason),''), auth.uid(), v_name);
end $$;
grant execute on function public.flag_stock_issue(uuid, text, text, numeric, text, text) to authenticated, anon, service_role;

-- Approve handles po_line / stock_recode / flag (batch_flag + stock_flag). Full body re-declared, safe to re-run.
create or replace function public.approve_wms_correction(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare r wms_correction_requests; v_name text; v_new_id uuid; v_desc text; v_uom text; v_s wms_stock; v_exists uuid; v_batch text;
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
    select id into v_exists from public.wms_stock
      where warehouse_code = v_s.warehouse_code and item_code = r.new_item_code and location_id = v_s.location_id and batch_no = v_s.batch_no and id <> v_s.id;
    if v_exists is not null then
      update public.wms_stock set quantity = quantity + v_s.quantity, updated_at = now() where id = v_exists;
      delete from public.wms_stock where id = v_s.id;
    else
      update public.wms_stock set item_code = r.new_item_code, item_id = coalesce(v_new_id, item_id),
        description = coalesce(v_desc, description), updated_at = now() where id = v_s.id;
    end if;
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values (v_s.warehouse_code, 'adjust', v_s.item_id, v_s.item_code, v_s.description, v_s.location_id, v_s.location_code, v_s.batch_no, v_s.exp_date, v_s.quantity, 'Re-code → ' || r.new_item_code, auth.uid(), v_name);
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values (v_s.warehouse_code, 'adjust', v_new_id, r.new_item_code, coalesce(v_desc, v_s.description), v_s.location_id, v_s.location_code, v_s.batch_no, v_s.exp_date, v_s.quantity, 'Re-code ← ' || v_s.item_code, auth.uid(), v_name);

  elsif r.kind in ('batch_flag', 'stock_flag') then
    -- Only the batch is auto-applied (safe label fix). A wrong item / quantity is left for the
    -- office to revise the source document; approving records that it was handled.
    v_batch := nullif(btrim(r.new_batch), '');
    if v_batch is not null then
      select * into v_s from public.wms_stock where id = r.stock_id;
      if not found then raise exception 'Stock line no longer exists'; end if;
      if v_batch <> coalesce(v_s.batch_no, '') then
        select id into v_exists from public.wms_stock
          where warehouse_code = v_s.warehouse_code and item_code = v_s.item_code and location_id = v_s.location_id and coalesce(batch_no,'') = v_batch and id <> v_s.id;
        if v_exists is not null then
          update public.wms_stock set quantity = quantity + v_s.quantity, updated_at = now() where id = v_exists;
          delete from public.wms_stock where id = v_s.id;
        else
          update public.wms_stock set batch_no = v_batch, updated_at = now() where id = v_s.id;
        end if;
        insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
        values (v_s.warehouse_code, 'adjust', v_s.item_id, v_s.item_code, v_s.description, v_s.location_id, v_s.location_code, v_s.location_id, v_s.location_code, v_batch, v_s.exp_date, v_s.quantity, 'Batch fix ' || coalesce(v_s.batch_no,'—') || ' → ' || v_batch, auth.uid(), v_name);
      end if;
    end if;

  else
    raise exception 'Unknown correction kind';
  end if;

  update public.wms_correction_requests set status='Approved', reviewed_by=auth.uid(), reviewed_by_name=v_name, reviewed_at=now() where id = p_id;
end $$;
grant execute on function public.approve_wms_correction(uuid) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
