-- Warehouse stock adjustments need Head Office approval.
-- When a NON-Head-Office warehouse user adjusts / removes / adds stock on the Warehouse Stock
-- page, it no longer changes stock straight away — it raises a request (wms_correction_requests,
-- kind 'stock_adjust') that shows up on the WMS Approvals page. Head Office approves it to apply
-- the change (sets the on-hand for that item/bin/batch, logging an 'adjust' move). Head Office /
-- admin adjustments still apply immediately, since they are the approving authority.
-- Run in the Supabase SQL editor. Safe to re-run.

-- Remember the target bin + expiry for an adjustment request.
alter table public.wms_correction_requests add column if not exists location_id uuid;
alter table public.wms_correction_requests add column if not exists exp_date date;

-- Raise a stock-adjustment request. Pass p_stock_id for an existing line, or item/bin/batch for a new one.
create or replace function public.request_stock_adjust(
  p_stock_id uuid, p_item_code text, p_location_id uuid, p_batch text, p_exp_date date, p_new_qty numeric, p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_s wms_stock; v_name text; v_item text; v_desc text; v_old numeric; v_loc uuid; v_loccode text; v_batch text; v_exp date;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  if p_new_qty is null or p_new_qty < 0 then raise exception 'Enter a valid quantity (0 or more)'; end if;
  if p_stock_id is not null then
    select * into v_s from public.wms_stock where id = p_stock_id;
    if not found then raise exception 'Stock line not found'; end if;
    if exists (select 1 from public.wms_correction_requests where kind='stock_adjust' and stock_id = p_stock_id and status='Pending') then
      raise exception 'An adjustment is already pending for this stock line'; end if;
    v_item := v_s.item_code; v_desc := v_s.description; v_old := v_s.quantity;
    v_loc := v_s.location_id; v_loccode := v_s.location_code; v_batch := v_s.batch_no; v_exp := v_s.exp_date;
  else
    if nullif(btrim(p_item_code),'') is null then raise exception 'Pick an item'; end if;
    if p_location_id is null then raise exception 'Pick a bin'; end if;
    v_item := upper(btrim(p_item_code)); v_loc := p_location_id; v_batch := btrim(coalesce(p_batch,'')); v_exp := p_exp_date;
    select code into v_loccode from public.wms_locations where id = p_location_id;
    if v_loccode is null then raise exception 'That bin is not in the Location Map'; end if;
    select description into v_desc from public.items where code = v_item limit 1;
    select quantity into v_old from public.wms_stock where item_code = v_item and location_id = v_loc and coalesce(batch_no,'') = coalesce(v_batch,'') limit 1;
    v_old := coalesce(v_old, 0);
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.wms_correction_requests (kind, stock_id, old_item_code, old_description, old_qty, new_qty,
    location_id, location_code, batch_no, exp_date, reason, requested_by, requested_by_name)
  values ('stock_adjust', p_stock_id, v_item, v_desc, v_old, p_new_qty,
    v_loc, v_loccode, v_batch, v_exp, nullif(btrim(p_reason),''), auth.uid(), v_name);
end $$;
grant execute on function public.request_stock_adjust(uuid, text, uuid, text, date, numeric, text) to authenticated, anon, service_role;

-- Approve handles po_line / stock_recode / flag / stock_adjust. Full body re-declared, safe to re-run.
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

  elsif r.kind = 'stock_adjust' then
    if r.location_id is null then raise exception 'Adjustment is missing its bin'; end if;
    perform public.wms_adjust_stock(r.old_item_code, r.location_id, coalesce(r.batch_no, ''), r.exp_date, r.new_qty,
      'approved adjustment' || case when r.reason is not null then ' · ' || r.reason else '' end);

  else
    raise exception 'Unknown correction kind';
  end if;

  update public.wms_correction_requests set status='Approved', reviewed_by=auth.uid(), reviewed_by_name=v_name, reviewed_at=now() where id = p_id;
end $$;
grant execute on function public.approve_wms_correction(uuid) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
