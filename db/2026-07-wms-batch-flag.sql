-- Flag a wrong batch number from Putaway, for the office to check.
-- Warehouse staff, while putting goods away, can flag a stock line whose batch number
-- looks wrong (typo, wrong bag scanned, etc). It rides the SAME approval envelope as the
-- other WMS corrections (wms_correction_requests, kind = 'batch_flag') so it shows up on
-- the WMS Approvals page. Head Office checks it and either:
--   * approves — if a corrected batch number was given, the stock line's batch is fixed
--     (merged into an existing same-item/same-bin/same-batch line if one exists), or
--   * rejects — the flag is cleared, nothing changes.
-- Run in the Supabase SQL editor. Safe to re-run.

-- 1) Somewhere to remember the corrected batch the flagger suggested.
alter table public.wms_correction_requests add column if not exists new_batch text;

-- 2) Raise a batch flag (warehouse edit permission).
create or replace function public.flag_batch_issue(p_stock_id uuid, p_correct_batch text default null, p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_s wms_stock; v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  select * into v_s from public.wms_stock where id = p_stock_id;
  if not found then raise exception 'Stock line not found'; end if;
  if exists (select 1 from public.wms_correction_requests where stock_id = p_stock_id and kind = 'batch_flag' and status = 'Pending') then
    raise exception 'This stock line is already flagged and waiting for the office'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.wms_correction_requests (kind, stock_id, old_item_code, old_description, old_qty, location_code, batch_no,
    new_batch, reason, requested_by, requested_by_name)
  values ('batch_flag', p_stock_id, v_s.item_code, v_s.description, v_s.quantity, v_s.location_code, v_s.batch_no,
    nullif(btrim(p_correct_batch),''), nullif(btrim(p_reason),''), auth.uid(), v_name);
end $$;
grant execute on function public.flag_batch_issue(uuid, text, text) to authenticated, anon, service_role;

-- 3) Approve now also handles 'batch_flag' (full body re-declared, safe to re-run).
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

  elsif r.kind = 'batch_flag' then
    -- Just clearing the flag if no corrected batch was suggested (office checked it in person).
    v_batch := nullif(btrim(r.new_batch), '');
    if v_batch is not null then
      select * into v_s from public.wms_stock where id = r.stock_id;
      if not found then raise exception 'Stock line no longer exists'; end if;
      if v_batch <> coalesce(v_s.batch_no, '') then
        -- Merge into an existing line for the same item/bin already on the corrected batch, else rename this one.
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
