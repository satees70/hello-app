-- Supplier returns / rejects. A bad delivery (wrong item, short, damaged, failed QC) can be
-- returned to the supplier with a record. Returning removes the goods from warehouse stock and
-- logs it. Damaged / QC-failed stock (already in DAMAGED) can also be sent back to the supplier as
-- a third Head-Office disposition (alongside write-off / return-to-stock).
--
-- Run in the Supabase SQL editor. Safe to re-run. Depends on db/2026-07-wms-damage.sql.

create table if not exists public.wms_supplier_returns (
  id uuid primary key default gen_random_uuid(),
  item_id uuid,
  item_code text,
  description text,
  uom text,
  batch text,
  qty numeric not null,
  reason text,                       -- wrong_item | short_shipped | damaged | quality | other
  note text,
  supplier_name text,
  from_location_code text,
  source text not null default 'manual',   -- manual | damage
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now()
);
alter table public.wms_supplier_returns enable row level security;
drop policy if exists wms_supplier_returns_read on public.wms_supplier_returns;
create policy wms_supplier_returns_read on public.wms_supplier_returns for select to authenticated
  using (has_perm('warehouse', 'view'));

-- Return a stock line to the supplier — removes the whole line from stock and records it.
create or replace function public.wms_return_to_supplier(p_stock_id uuid, p_reason text default null, p_supplier text default null, p_note text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare s public.wms_stock; v_name text;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed'; end if;
  select * into s from public.wms_stock where id = p_stock_id;
  if not found or s.quantity <= 0 then raise exception 'Stock line not found'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'adjust', s.item_id, s.item_code, s.description, s.location_id, s.location_code, s.batch_no, s.exp_date, s.quantity,
    'Returned to supplier' || case when nullif(btrim(p_reason), '') is not null then ' (' || btrim(p_reason) || ')' else '' end
      || case when nullif(btrim(p_note), '') is not null then ' · ' || btrim(p_note) else '' end, auth.uid(), v_name);
  insert into public.wms_supplier_returns (item_id, item_code, description, uom, batch, qty, reason, note, supplier_name, from_location_code, source, created_by, created_by_name)
  values (s.item_id, s.item_code, s.description, s.uom, s.batch_no, s.quantity, nullif(btrim(p_reason), ''), nullif(btrim(p_note), ''), nullif(btrim(p_supplier), ''), s.location_code, 'manual', auth.uid(), v_name);
  delete from public.wms_stock where id = p_stock_id;
end $$;
grant execute on function public.wms_return_to_supplier(uuid, text, text, text) to authenticated;

-- Head-Office disposition on a damage report: send the quarantined stock back to the supplier.
create or replace function public.resolve_damage_return_supplier(p_id uuid)
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
    'Returned to supplier (damage/QC) - HO ' || coalesce(v_name, ''), auth.uid(), v_name);
  insert into public.wms_supplier_returns (item_id, item_code, description, uom, batch, qty, reason, note, from_location_code, source, created_by, created_by_name)
  values (v_r.item_id, v_r.item_code, v_r.description, v_r.uom, v_batch, v_r.qty, 'damaged', v_r.note, 'DAMAGED', 'damage', auth.uid(), v_name);

  update public.wms_damage_reports set status = 'ReturnedSupplier', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.resolve_damage_return_supplier(uuid) to authenticated;

notify pgrst, 'reload schema';
