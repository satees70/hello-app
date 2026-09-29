-- WMS9 transfer-only + cross-dock request reduction — PART 2 of 5: set_do_line_destination, confirm_do_line and confirm_do_return with the WMS9 guard.
-- Run parts 1 to 5 in order, each on its own, in the Supabase SQL editor. Safe to re-run.
-- The full explanation is at the top of part 1.

CREATE OR REPLACE FUNCTION public.set_do_line_destination(p_line_id uuid, p_warehouse_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text; v_fg public.dispatch_order_lines; v_ret public.material_returns;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false)
          or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can switch a delivery line';
  end if;
  if not public.wms_valid_destination(p_warehouse_code) then
    raise exception 'That warehouse has no GOODS-IN bin — it cannot receive goods yet';
  end if;
  -- ⚠️ A transfer-only building (WMS9) is reached by a building transfer, never by re-addressing.
  if public.wms_is_transfer_only(p_warehouse_code) and not public._wms_in_crossdock() then
    raise exception '% only takes goods by building transfer — receive it here and use Send on to %.', p_warehouse_code, p_warehouse_code;
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  select * into v_fg from public.dispatch_order_lines where id = p_line_id;
  if found then
    if v_fg.received_at is not null then
      raise exception 'That item has already been received — it cannot be sent to another warehouse now';
    end if;
    update public.dispatch_order_lines
       set warehouse_code = p_warehouse_code, warehouse_changed_at = now(),
           warehouse_changed_by = auth.uid(), warehouse_changed_by_name = v_name
     where id = p_line_id;
    return;
  end if;

  select * into v_ret from public.material_returns where id = p_line_id;
  if not found then raise exception 'Delivery line not found'; end if;
  if v_ret.received_at is not null then
    raise exception 'That return has already been received — it cannot be sent to another warehouse now';
  end if;
  update public.material_returns
     set warehouse_code = p_warehouse_code, warehouse_changed_at = now(),
         warehouse_changed_by = auth.uid(), warehouse_changed_by_name = v_name
   where id = p_line_id;
end $function$;


CREATE OR REPLACE FUNCTION public.confirm_do_line(p_line_id uuid, p_photo_path text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text; v_do uuid; v_pending int; v_line public.dispatch_order_lines; v_wh text; v_mine text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can confirm a delivery line';
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  select * into v_line from public.dispatch_order_lines where id = p_line_id;
  if not found then raise exception 'Delivery line not found'; end if;

  -- Someone pinned to one building must not receive goods addressed to the other. If the
  -- lorry really came here, the line is switched first -- that keeps the paperwork honest.
  v_wh := public.wms_do_line_wh(p_line_id);
  v_mine := public.my_warehouse_code();
  if v_mine is not null and v_wh is distinct from v_mine then
    raise exception 'This item is addressed to another warehouse — switch it to yours first if it arrived here';
  end if;
  -- ⚠️ A transfer-only building (WMS9) books goods in only off a cross-dock load.
  if public.wms_is_transfer_only(v_wh) and not public._wms_in_crossdock()
     and not exists (select 1 from public.wms_transfer_only_exempt where line_id = p_line_id) then
    raise exception '% only takes goods by building transfer — switch this line to the unloading building, receive it there and send it on.', v_wh;
  end if;

  v_do := v_line.dispatch_id;
  update public.dispatch_order_lines
     set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name,
         photo_path = coalesce(nullif(p_photo_path, ''), photo_path)
   where id = p_line_id;

  perform public._wms_book_do_line(p_line_id, auth.uid(), v_name);

  select count(*) into v_pending from public.dispatch_order_lines where dispatch_id = v_do and received_at is null;
  if v_pending = 0 then
    update public.dispatch_orders set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name where id = v_do;
    insert into public.notifications (author_id, factory_code, type, title, body, link, ref)
    select auth.uid(), d.factory_code, 'dispatch', '📦 Delivery received at warehouse',
           'Delivery order ' || coalesce(d.do_number, '') || ' fully received'
             || case when nullif(d.warehouse_grn, '') is not null then ' · GRN ' || d.warehouse_grn else '' end
             || ' by ' || coalesce(v_name, 'warehouse') || '.',
           '/dispatch', 'do_received:' || d.id::text
      from public.dispatch_orders d where d.id = v_do
      on conflict (ref) do nothing;
  end if;
end $function$;


CREATE OR REPLACE FUNCTION public.confirm_do_return(p_return_id uuid, p_photo_path text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text; v_do uuid; v_ret public.material_returns;
  v_item_id uuid; v_desc text; v_uom text; v_stage uuid; v_dono text; v_grn text; v_batch text;
  v_wh text; v_mine text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can confirm a return';
  end if;

  v_wh := public.wms_do_return_wh(p_return_id);
  if v_wh is null then raise exception 'Return line not found'; end if;
  v_mine := public.my_warehouse_code();
  if v_mine is not null and v_wh is distinct from v_mine then
    raise exception 'This return is addressed to another warehouse — switch it to yours first if it arrived here';
  end if;
  -- ⚠️ A transfer-only building (WMS9) books goods in only off a cross-dock load.
  if public.wms_is_transfer_only(v_wh) and not public._wms_in_crossdock()
     and not exists (select 1 from public.wms_transfer_only_exempt where line_id = p_return_id) then
    raise exception '% only takes goods by building transfer — switch this line to the unloading building, receive it there and send it on.', v_wh;
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  update public.material_returns
     set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name,
         photo_path = coalesce(nullif(p_photo_path, ''), photo_path)
   where id = p_return_id returning * into v_ret;
  if v_ret.id is null then raise exception 'Return line not found'; end if;
  v_do := v_ret.dispatch_id;

  if v_ret.wms_booked_at is null and coalesce(v_ret.quantity, 0) > 0 and nullif(btrim(v_ret.item_code), '') is not null then
    v_batch := coalesce(v_ret.batch_no, '');
    select id, description, unit into v_item_id, v_desc, v_uom from public.items where code = v_ret.item_code;
    select id into v_stage from public.wms_locations where warehouse_code = v_wh and code = 'GOODS-IN';
    select do_number, warehouse_grn into v_dono, v_grn from public.dispatch_orders where id = v_do;
    if v_stage is null then raise exception 'Warehouse % has no GOODS-IN bin — the return cannot be booked in', v_wh; end if;
    insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values (v_wh, v_item_id, v_ret.item_code, coalesce(v_ret.description, v_desc), v_stage, 'GOODS-IN', v_batch, v_ret.exp_date, v_ret.quantity, v_uom)
    on conflict (warehouse_code, item_code, location_id, batch_no, exp_date)
      do update set quantity = wms_stock.quantity + excluded.quantity, updated_at = now();
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values (v_wh, 'receipt', v_item_id, v_ret.item_code, coalesce(v_ret.description, v_desc), v_stage, 'GOODS-IN', v_batch, v_ret.exp_date, v_ret.quantity,
      'DO ' || coalesce(v_dono, '') || case when nullif(v_grn, '') is not null then ' · GRN ' || v_grn else '' end || ' (return)', auth.uid(), v_name);
    update public.material_returns set wms_booked_at = now() where id = p_return_id;
  end if;

  perform public._do_receipt_rollup(v_do, v_name);
end $function$;

-- END OF PART 2 of 5
