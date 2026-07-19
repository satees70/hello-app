-- Customer returns (goods coming back on a credit note). Costing stays in SQL Account — here we only
-- move the QUANTITY. Returned finished goods land in a non-pickable RETURNS quarantine bin, get a
-- quality check, then: PASS → transferred to a normal (sellable) location; FAIL → sent to DAMAGED,
-- raising a damage report for Head Office to decide (write off / return to stock / return to supplier).
--
-- Run in the Supabase SQL editor. Safe to re-run. Depends on db/2026-07-wms-damage.sql + credit-notes.

-- 1) RETURNS quarantine bin (non-pickable — never picked or auto-staged).
insert into public.wms_locations (warehouse_code, category, location_type, code, label, active, pickable)
select '8BT', 'Stock', 'STAGE', 'RETURNS', 'Customer returns - awaiting quality check', true, false
where not exists (select 1 from public.wms_locations where warehouse_code = '8BT' and code = 'RETURNS');
update public.wms_locations set active = true, pickable = false
  where warehouse_code = '8BT' and code = 'RETURNS';

-- 2) Credit notes are handled in the warehouse app too — allow warehouse view/edit (as well as sales).
drop policy if exists credit_notes_read on public.credit_notes;
create policy credit_notes_read on public.credit_notes for select to authenticated
  using (has_perm('sales', 'view') or has_perm('warehouse', 'view'));
drop policy if exists credit_notes_write on public.credit_notes;
create policy credit_notes_write on public.credit_notes for all to authenticated
  using (has_perm('sales', 'edit') or has_perm('warehouse', 'edit'))
  with check (has_perm('sales', 'edit') or has_perm('warehouse', 'edit'));

-- 3) Receive a customer return into the RETURNS quarantine bin (quantity only).
create or replace function public.wms_receive_customer_return(p_item_code text, p_qty numeric, p_batch text default null, p_exp_date date default null, p_reference text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_ret uuid; v_id uuid; v_desc text; v_uom text; v_name text; v_batch text := coalesce(nullif(btrim(p_batch), ''), '');
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed'; end if;
  if nullif(btrim(p_item_code), '') is null then raise exception 'Item required'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  select id into v_ret from public.wms_locations where warehouse_code = '8BT' and code = 'RETURNS';
  if v_ret is null then raise exception 'RETURNS bin missing - run db/2026-07-wms-customer-returns.sql'; end if;
  select id, description, unit into v_id, v_desc, v_uom from public.items where code = p_item_code;
  select full_name into v_name from public.profiles where id = auth.uid();

  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', v_id, p_item_code, v_desc, v_ret, 'RETURNS', v_batch, p_exp_date, p_qty, v_uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
  -- 'adjust' (not 'receipt') so it doesn't trigger auto-pick — quarantined returns aren't sellable yet.
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'adjust', v_id, p_item_code, v_desc, v_ret, 'RETURNS', v_batch, p_exp_date, p_qty,
    'Customer return' || case when nullif(btrim(p_reference), '') is not null then ' · ' || btrim(p_reference) else '' end, auth.uid(), v_name);
end $$;
grant execute on function public.wms_receive_customer_return(text, numeric, text, date, text) to authenticated;

-- 4) PASS quality check → transfer the whole line from RETURNS to a chosen (sellable) location.
create or replace function public.wms_return_pass(p_stock_id uuid, p_location_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare s public.wms_stock; v_to text; v_name text;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed'; end if;
  select * into s from public.wms_stock where id = p_stock_id;
  if not found or s.quantity <= 0 then raise exception 'Stock line not found'; end if;
  if s.location_code <> 'RETURNS' then raise exception 'This line is not in RETURNS'; end if;
  select code into v_to from public.wms_locations where id = p_location_id;
  if v_to is null then raise exception 'Choose a destination bin'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', s.item_id, s.item_code, s.description, p_location_id, v_to, s.batch_no, s.exp_date, s.quantity, s.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'transfer', s.item_id, s.item_code, s.description, s.location_id, 'RETURNS', p_location_id, v_to, s.batch_no, s.exp_date, s.quantity, 'Return passed QC', auth.uid(), v_name);
  delete from public.wms_stock where id = p_stock_id;
end $$;
grant execute on function public.wms_return_pass(uuid, uuid) to authenticated;

-- 5) FAIL quality check → move to DAMAGED and raise a damage report for Head Office to decide.
create or replace function public.wms_return_fail(p_stock_id uuid, p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare s public.wms_stock; v_dmg uuid; v_name text; v_note text;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed'; end if;
  select * into s from public.wms_stock where id = p_stock_id;
  if not found or s.quantity <= 0 then raise exception 'Stock line not found'; end if;
  if s.location_code <> 'RETURNS' then raise exception 'This line is not in RETURNS'; end if;
  select id into v_dmg from public.wms_locations where warehouse_code = '8BT' and code = 'DAMAGED';
  if v_dmg is null then raise exception 'DAMAGED bin missing - run db/2026-07-wms-damage.sql'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  v_note := 'Customer return failed QC' || case when nullif(btrim(p_reason), '') is not null then ': ' || btrim(p_reason) else '' end;

  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', s.item_id, s.item_code, s.description, v_dmg, 'DAMAGED', s.batch_no, s.exp_date, s.quantity, s.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'transfer', s.item_id, s.item_code, s.description, s.location_id, 'RETURNS', v_dmg, 'DAMAGED', s.batch_no, s.exp_date, s.quantity, v_note, auth.uid(), v_name);
  insert into public.wms_damage_reports (item_id, item_code, description, uom, from_location_id, from_location_code, batch, qty, note, reported_by, reported_by_name)
  values (s.item_id, s.item_code, s.description, s.uom, v_dmg, 'DAMAGED', s.batch_no, s.quantity, v_note, auth.uid(), v_name);
  delete from public.wms_stock where id = p_stock_id;

  insert into public.notifications (factory_code, type, title, body, link, ref)
  values ('HEAD_OFFICE', 'wms', '↩ Customer return failed QC', coalesce(s.item_code, '') || ' × ' || s.quantity::text || ' - HO to decide', '/wms/approvals', 'retfail:' || p_stock_id::text)
  on conflict (ref) do nothing;
end $$;
grant execute on function public.wms_return_fail(uuid, text) to authenticated;

notify pgrst, 'reload schema';
