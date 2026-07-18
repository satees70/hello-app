-- Damaged stock — quarantine to a DAMAGED bin, then Head Office decides what to do.
--
-- When a picker finds stock physically there but damaged (torn bag / gunny), they enter the bin +
-- batch + quantity. It's moved out of the pickable bin into a DAMAGED holding location (a 'transfer'
-- move) and a report is raised. Head Office reviews and decides: WRITE OFF (remove from stock) or
-- RETURN TO STOCK (move it back to the bin it came from). Nothing leaves stock without HO sign-off.
--
-- Run in the Supabase SQL editor. Safe to re-run.

-- 1) DAMAGED holding location (non-pickable, so it's never picked or auto-staged).
insert into public.wms_locations (warehouse_code, category, location_type, code, label, active, pickable)
select '8BT', 'Stock', 'STAGE', 'DAMAGED', 'Damaged — awaiting Head Office review', true, false
where not exists (select 1 from public.wms_locations where warehouse_code = '8BT' and code = 'DAMAGED');
update public.wms_locations set active = true, pickable = false
  where warehouse_code = '8BT' and code = 'DAMAGED';

-- 2) Damage reports queue.
create table if not exists public.wms_damage_reports (
  id uuid primary key default gen_random_uuid(),
  order_id uuid,
  order_no text,
  line_id uuid,
  item_id uuid,
  item_code text,
  description text,
  uom text,
  from_location_id uuid,
  from_location_code text,
  batch text,
  qty numeric not null,
  note text,
  status text not null default 'Pending',    -- Pending | WrittenOff | Returned
  reported_by uuid,
  reported_by_name text,
  reviewed_by uuid,
  reviewed_by_name text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.wms_damage_reports enable row level security;
drop policy if exists wms_damage_read on public.wms_damage_reports;
create policy wms_damage_read on public.wms_damage_reports for select to authenticated
  using (has_perm('warehouse', 'view') or reported_by = auth.uid());
-- writes only via the SECURITY DEFINER RPCs below

-- 3) Picker reports damage → quarantine the qty into DAMAGED and raise a report.
create or replace function public.wms_report_damage(p_line_id uuid, p_location_id uuid, p_batch text, p_qty numeric, p_note text default null)
  returns uuid language plpgsql security definer set search_path = public as $$
declare v_line public.wms_order_lines; v_order public.wms_orders; v_name text; v_src text; v_dmg uuid; v_batch text := coalesce(nullif(btrim(p_batch), ''), ''); v_exists boolean; v_id uuid;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to move warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Damaged quantity must be greater than zero'; end if;
  if p_location_id is null then raise exception 'Choose the bin the damaged stock is in'; end if;
  select * into v_line from public.wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from public.wms_orders where id = v_line.order_id;
  select code into v_src from public.wms_locations where id = p_location_id;
  if v_src is null then raise exception 'Bin not found'; end if;
  select id into v_dmg from public.wms_locations where warehouse_code = '8BT' and code = 'DAMAGED';
  if v_dmg is null then raise exception 'DAMAGED location missing — run db/2026-07-wms-damage.sql'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  -- take the damaged qty out of the source bin
  select true into v_exists from public.wms_stock
    where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = p_location_id and batch_no = v_batch limit 1;
  if v_exists then
    update public.wms_stock set quantity = quantity - p_qty, updated_at = now()
      where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = p_location_id and batch_no = v_batch;
    delete from public.wms_stock where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = p_location_id and batch_no = v_batch and quantity <= 0;
  else
    insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, quantity, uom)
    values ('8BT', v_line.item_id, v_line.item_code, v_line.description, p_location_id, v_src, v_batch, -p_qty, v_line.uom);
  end if;
  -- and hold it in DAMAGED
  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, quantity, uom)
  values ('8BT', v_line.item_id, v_line.item_code, v_line.description, v_dmg, 'DAMAGED', v_batch, p_qty, v_line.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, updated_at = now();
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'transfer', v_line.item_id, v_line.item_code, v_line.description,
    p_location_id, v_src, v_dmg, 'DAMAGED', v_batch, p_qty,
    'Damaged — quarantined for HO review' || case when nullif(btrim(p_note), '') is not null then ' · ' || btrim(p_note) else '' end, auth.uid(), v_name);

  insert into public.wms_damage_reports (order_id, order_no, line_id, item_id, item_code, description, uom, from_location_id, from_location_code, batch, qty, note, reported_by, reported_by_name)
  values (v_line.order_id, v_order.order_no, p_line_id, v_line.item_id, v_line.item_code, v_line.description, v_line.uom, p_location_id, v_src, v_batch, p_qty, nullif(btrim(p_note), ''), auth.uid(), v_name)
  returning id into v_id;

  insert into public.notifications (factory_code, type, title, body, link, ref)
  values ('HEAD_OFFICE', 'wms', '🐛 Damaged stock — review',
    coalesce(v_line.item_code, '') || ' × ' || p_qty::text || ' from ' || v_src || case when v_batch <> '' then ' · b:' || v_batch else '' end
      || ' quarantined by ' || coalesce(v_name, '?') || case when nullif(btrim(p_note), '') is not null then ' · ' || btrim(p_note) else '' end,
    '/wms/approvals', 'damage:' || v_id::text)
  on conflict (ref) do nothing;
  return v_id;
end $$;
grant execute on function public.wms_report_damage(uuid, uuid, text, numeric, text) to authenticated;

-- 4a) HO decides: WRITE OFF — remove the damaged qty from stock for good.
create or replace function public.resolve_damage_writeoff(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_r public.wms_damage_reports; v_name text; v_dmg uuid; v_batch text;
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can resolve damaged stock'; end if;
  select * into v_r from public.wms_damage_reports where id = p_id;
  if not found then raise exception 'Damage report not found'; end if;
  if v_r.status <> 'Pending' then raise exception 'This damage report was already handled'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  v_batch := coalesce(v_r.batch, '');
  select id into v_dmg from public.wms_locations where warehouse_code = '8BT' and code = 'DAMAGED';

  update public.wms_stock set quantity = quantity - v_r.qty, updated_at = now()
    where warehouse_code = '8BT' and item_code = v_r.item_code and location_id = v_dmg and batch_no = v_batch;
  delete from public.wms_stock where warehouse_code = '8BT' and item_code = v_r.item_code and location_id = v_dmg and batch_no = v_batch and quantity <= 0;
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, batch_no, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'adjust', v_r.item_id, v_r.item_code, v_r.description, v_dmg, 'DAMAGED', v_batch, v_r.qty,
    'Damage write-off (HO ' || coalesce(v_name, '') || ')', auth.uid(), v_name);

  update public.wms_damage_reports set status = 'WrittenOff', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.resolve_damage_writeoff(uuid) to authenticated;

-- 4b) HO decides: RETURN TO STOCK — move it back to the bin it came from.
create or replace function public.resolve_damage_return(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_r public.wms_damage_reports; v_name text; v_dmg uuid; v_batch text;
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can resolve damaged stock'; end if;
  select * into v_r from public.wms_damage_reports where id = p_id;
  if not found then raise exception 'Damage report not found'; end if;
  if v_r.status <> 'Pending' then raise exception 'This damage report was already handled'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  v_batch := coalesce(v_r.batch, '');
  select id into v_dmg from public.wms_locations where warehouse_code = '8BT' and code = 'DAMAGED';

  update public.wms_stock set quantity = quantity - v_r.qty, updated_at = now()
    where warehouse_code = '8BT' and item_code = v_r.item_code and location_id = v_dmg and batch_no = v_batch;
  delete from public.wms_stock where warehouse_code = '8BT' and item_code = v_r.item_code and location_id = v_dmg and batch_no = v_batch and quantity <= 0;
  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, quantity, uom)
  values ('8BT', v_r.item_id, v_r.item_code, v_r.description, v_r.from_location_id, v_r.from_location_code, v_batch, v_r.qty, v_r.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, updated_at = now();
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'transfer', v_r.item_id, v_r.item_code, v_r.description,
    v_dmg, 'DAMAGED', v_r.from_location_id, v_r.from_location_code, v_batch, v_r.qty,
    'Damage returned to stock (HO ' || coalesce(v_name, '') || ')', auth.uid(), v_name);

  update public.wms_damage_reports set status = 'Returned', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.resolve_damage_return(uuid) to authenticated;

notify pgrst, 'reload schema';
