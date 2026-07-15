-- Purchase-order receiving: require a product photo, a BAG photo, and the product WEIGHT before a
-- line can be received. Adds two columns to the GRN line and extends wms_receive_line to store them.
--
-- Run in the Supabase SQL editor. Safe to re-run.

alter table public.wms_grn_lines add column if not exists bag_photo_path text;
alter table public.wms_grn_lines add column if not exists weight numeric;

drop function if exists public.wms_receive_line(uuid, uuid, text, numeric, text, date, text, text, text);
create or replace function public.wms_receive_line(
  p_grn_id uuid, p_po_line_id uuid, p_item_code text, p_qty numeric,
  p_batch text, p_exp_date date, p_qc text, p_qc_note text, p_photo_path text,
  p_bag_photo_path text default null, p_weight numeric default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item_id uuid; v_desc text; v_uom text; v_stage uuid; v_name text; v_po_id uuid;
  v_batch text := coalesce(p_batch,'');
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to receive goods'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  if coalesce(p_photo_path,'') = '' then raise exception 'A product photo is required'; end if;
  if coalesce(p_bag_photo_path,'') = '' then raise exception 'A bag photo is required'; end if;
  if p_weight is null or p_weight <= 0 then raise exception 'The product weight is required'; end if;
  select id, description, unit into v_item_id, v_desc, v_uom from items where code = p_item_code;
  select id into v_stage from wms_locations where warehouse_code='8BT' and code='GOODS-IN';
  if v_stage is null then raise exception 'GOODS-IN staging bin is missing — run the WMS purchasing migration'; end if;
  select full_name into v_name from profiles where id = auth.uid();

  insert into wms_grn_lines (grn_id, po_line_id, item_id, item_code, description, qty_received, batch_no, exp_date, qc_status, qc_note, photo_path, bag_photo_path, weight)
  values (p_grn_id, p_po_line_id, v_item_id, p_item_code, v_desc, p_qty, v_batch, p_exp_date, coalesce(p_qc,'pass'), p_qc_note, p_photo_path, p_bag_photo_path, p_weight);

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
grant execute on function public.wms_receive_line(uuid, uuid, text, numeric, text, date, text, text, text, text, numeric) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
