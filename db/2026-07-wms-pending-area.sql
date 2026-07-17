-- A dedicated PENDING staging bin: when goods arrive for orders that are waiting (no-stock),
-- putaway staff move the needed quantity into PENDING (kept separate from general warehouse
-- stock) and shelf the rest. PENDING is a normal PICKABLE location, so pickers can pull the
-- staged stock for those orders. Run in the Supabase SQL editor. Safe to re-run.

insert into public.wms_locations (warehouse_code, category, location_type, code, label, active)
select '8BT', 'Stock', 'SL', 'PENDING', 'Pending — awaiting orders', true
where not exists (select 1 from public.wms_locations where warehouse_code = '8BT' and code = 'PENDING');

-- Make sure it stays active + pickable if it already existed.
update public.wms_locations set active = true, pickable = true
  where warehouse_code = '8BT' and code = 'PENDING';
