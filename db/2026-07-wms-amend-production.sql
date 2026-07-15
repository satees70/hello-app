-- Amend a production order after it was created (e.g. wrong bag size chosen). Allowed only
-- while NOTHING has been picked yet — it releases the order's reservations, replaces the
-- lines with the corrected ones, and sends the order back to Review to be re-released/picked.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create or replace function public.wms_amend_production_order(p_order_id uuid, p_lines jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_order wms_orders; el jsonb; v_code text; v_qty numeric; v_uom text; v_itemid uuid; v_line int := 0;
begin
  if not (is_ho_or_admin() or has_perm('warehouse','edit')) then raise exception 'Not allowed to amend'; end if;
  select * into v_order from wms_orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
  if v_order.source <> 'production' then raise exception 'Only production orders can be amended here'; end if;
  if v_order.status in ('Dispatched','Partially Dispatched','Cancelled') then
    raise exception 'This order is already dispatched/cancelled — cannot amend';
  end if;
  if exists (select 1 from wms_order_lines where order_id = p_order_id and coalesce(qty_picked, 0) > 0) then
    raise exception 'Some items are already picked — cancel and recreate the order instead of amending';
  end if;

  update wms_reservations set status = 'released', released_at = now() where order_id = p_order_id and status = 'active';
  delete from wms_order_lines where order_id = p_order_id;
  for el in select jsonb_array_elements(p_lines) loop
    v_code := el->>'item_code'; v_qty := (el->>'quantity')::numeric; v_uom := el->>'uom';
    if v_code is null or v_qty is null or v_qty <= 0 then continue; end if;
    v_itemid := nullif(el->>'item_id','')::uuid;
    if v_itemid is null then select id into v_itemid from items where code = v_code limit 1; end if;
    v_line := v_line + 1;
    insert into wms_order_lines (order_id, line_no, item_id, item_code, description, quantity, qty_picked, uom)
    values (p_order_id, v_line, v_itemid, v_code, el->>'description', v_qty, 0, coalesce(v_uom, 'BAG'));
  end loop;
  update wms_orders set status = 'Review', pick_started_at = null, pick_completed_at = null where id = p_order_id;
end $$;
grant execute on function public.wms_amend_production_order(uuid, jsonb) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
