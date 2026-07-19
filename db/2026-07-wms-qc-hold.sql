-- Incoming QC hold / release. Received goods can be put on QC HOLD (a non-pickable bin) so they
-- can't be picked until quality-checked, then PASSED (released back to available stock) or FAILED
-- (sent to DAMAGED, raising a damage report for Head Office to write off or return to the supplier).
--
-- Run in the Supabase SQL editor. Safe to re-run. Depends on db/2026-07-wms-damage.sql (DAMAGED bin).

-- 1) QC-HOLD holding bin (non-pickable, so held stock is never picked or auto-staged).
insert into public.wms_locations (warehouse_code, category, location_type, code, label, active, pickable)
select '8BT', 'Stock', 'STAGE', 'QC-HOLD', 'Quality hold - awaiting QC check', true, false
where not exists (select 1 from public.wms_locations where warehouse_code = '8BT' and code = 'QC-HOLD');
update public.wms_locations set active = true, pickable = false
  where warehouse_code = '8BT' and code = 'QC-HOLD';

-- 2) Per-item "requires QC on receipt" flag (a reminder to hold it; lives with reorder_level).
alter table public.wms_item_settings add column if not exists qc_required boolean not null default false;

-- 3) Put a received stock line on QC hold — moves the whole bin/batch line into QC-HOLD.
create or replace function public.wms_qc_hold(p_stock_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare s public.wms_stock; v_qc uuid; v_name text;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed'; end if;
  select * into s from public.wms_stock where id = p_stock_id;
  if not found or s.quantity <= 0 then raise exception 'Stock line not found'; end if;
  select id into v_qc from public.wms_locations where warehouse_code = '8BT' and code = 'QC-HOLD';
  if v_qc is null then raise exception 'QC-HOLD bin missing - run db/2026-07-wms-qc-hold.sql'; end if;
  if s.location_id = v_qc then return; end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', s.item_id, s.item_code, s.description, v_qc, 'QC-HOLD', s.batch_no, s.exp_date, s.quantity, s.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'transfer', s.item_id, s.item_code, s.description, s.location_id, s.location_code, v_qc, 'QC-HOLD', s.batch_no, s.exp_date, s.quantity, 'Held for QC', auth.uid(), v_name);
  delete from public.wms_stock where id = p_stock_id;
end $$;
grant execute on function public.wms_qc_hold(uuid) to authenticated;

-- 4) QC PASS — release from QC-HOLD back into GOODS-IN (then normal putaway / picking).
create or replace function public.wms_qc_pass(p_stock_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare s public.wms_stock; v_gi uuid; v_name text;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed'; end if;
  select * into s from public.wms_stock where id = p_stock_id;
  if not found or s.quantity <= 0 then raise exception 'Stock line not found'; end if;
  if s.location_code <> 'QC-HOLD' then raise exception 'This line is not on QC hold'; end if;
  select id into v_gi from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
  select full_name into v_name from public.profiles where id = auth.uid();

  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', s.item_id, s.item_code, s.description, v_gi, 'GOODS-IN', s.batch_no, s.exp_date, s.quantity, s.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'transfer', s.item_id, s.item_code, s.description, s.location_id, 'QC-HOLD', v_gi, 'GOODS-IN', s.batch_no, s.exp_date, s.quantity, 'QC passed', auth.uid(), v_name);
  delete from public.wms_stock where id = p_stock_id;
end $$;
grant execute on function public.wms_qc_pass(uuid) to authenticated;

-- 5) QC FAIL — send from QC-HOLD to DAMAGED and raise a damage report for Head Office to resolve.
create or replace function public.wms_qc_fail(p_stock_id uuid, p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare s public.wms_stock; v_dmg uuid; v_name text; v_note text;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed'; end if;
  select * into s from public.wms_stock where id = p_stock_id;
  if not found or s.quantity <= 0 then raise exception 'Stock line not found'; end if;
  if s.location_code <> 'QC-HOLD' then raise exception 'This line is not on QC hold'; end if;
  select id into v_dmg from public.wms_locations where warehouse_code = '8BT' and code = 'DAMAGED';
  if v_dmg is null then raise exception 'DAMAGED bin missing - run db/2026-07-wms-damage.sql'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  v_note := 'QC fail' || case when nullif(btrim(p_reason), '') is not null then ': ' || btrim(p_reason) else '' end;

  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', s.item_id, s.item_code, s.description, v_dmg, 'DAMAGED', s.batch_no, s.exp_date, s.quantity, s.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'transfer', s.item_id, s.item_code, s.description, s.location_id, 'QC-HOLD', v_dmg, 'DAMAGED', s.batch_no, s.exp_date, s.quantity, v_note, auth.uid(), v_name);

  insert into public.wms_damage_reports (item_id, item_code, description, uom, from_location_id, from_location_code, batch, qty, note, reported_by, reported_by_name)
  values (s.item_id, s.item_code, s.description, s.uom, v_dmg, 'DAMAGED', s.batch_no, s.quantity, v_note, auth.uid(), v_name);
  delete from public.wms_stock where id = p_stock_id;

  insert into public.notifications (factory_code, type, title, body, link, ref)
  values ('HEAD_OFFICE', 'wms', '🔬 QC failed - stock quarantined',
    coalesce(s.item_code, '') || ' × ' || s.quantity::text || case when s.batch_no <> '' then ' · b:' || s.batch_no else '' end || ' failed QC (' || coalesce(v_name, '?') || ')' || case when nullif(btrim(p_reason), '') is not null then ' · ' || btrim(p_reason) else '' end,
    '/wms/approvals', 'qcfail:' || p_stock_id::text)
  on conflict (ref) do nothing;
end $$;
grant execute on function public.wms_qc_fail(uuid, text) to authenticated;

notify pgrst, 'reload schema';
