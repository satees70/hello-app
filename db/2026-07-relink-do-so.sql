-- Fix a WRONG Sales-Order link on a delivery line.
--
-- Staff can already link a delivery line to a Sales Order ("Link to order(s)"), which marks that
-- SO delivered and reduces its outstanding qty. But if it was linked to the WRONG SO there was no
-- way to undo it. This adds unlink_line_from_so(), which reverses one SO link on a delivery line:
--   • gives the wrongly-linked order its outstanding quantity back (delivered_qty − credit),
--   • clears delivered_do / delivered_at where they pointed at this delivery,
--   • removes the batch↔SO allocation (finished goods) so the line no longer shows that SO.
-- The app then reopens the Link screen so staff pick the correct order. Same permission as linking
-- (dispatch 'edit' + the delivery's own factory, or Head Office).
--
-- Run in the Supabase SQL editor. Safe to re-run.

create or replace function public.unlink_line_from_so(p_line_id uuid, p_is_return boolean, p_so text)
  returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_item text; v_fac text; v_do text; v_batch uuid; v_did uuid; v_qty numeric; v_sl record;
begin
  if p_is_return then
    select item_code, factory_code, dispatch_id, quantity into v_item, v_fac, v_did, v_qty
      from public.material_returns where id = p_line_id;
    if v_item is null then raise exception 'Return line not found'; end if;
  else
    select item_code, batch_id, dispatch_id into v_item, v_batch, v_did
      from public.dispatch_order_lines where id = p_line_id;
    if v_item is null then raise exception 'Delivery line not found'; end if;
    select factory_code into v_fac from public.dispatch_orders where id = v_did;
  end if;
  select do_number into v_do from public.dispatch_orders where id = v_did;
  if not has_perm('dispatch', 'edit') then raise exception 'Not allowed'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_fac = any (my_factory_codes())) then
    raise exception 'Not your factory';
  end if;

  -- how much delivery credit to remove: for finished goods, the batch↔SO allocation qty
  -- (exactly what linking added); for a return, the return line's quantity.
  if not p_is_return and v_batch is not null then
    select quantity into v_qty from public.production_batch_items where batch_id = v_batch and so_number = p_so;
  end if;

  -- reverse the delivered credit on the (wrongly) linked sales order line
  select id, delivered_do into v_sl from public.sales_order_lines
    where so_number = p_so and item_code = v_item and factory_code = v_fac and coalesce(delivered_qty, 0) > 0
    order by (delivered_do is not distinct from v_do) desc, coalesce(delivered_qty, 0) desc
    limit 1;
  if found then
    update public.sales_order_lines
      set delivered_qty = greatest(0, coalesce(delivered_qty, 0) - coalesce(v_qty, 0)),
          delivered_do  = case when delivered_do is not distinct from v_do then null else delivered_do end,
          delivered_at  = case when delivered_do is not distinct from v_do then null else delivered_at end
      where id = v_sl.id;
  end if;

  -- drop the batch↔SO allocation so the delivery line no longer shows that SO (finished goods)
  if not p_is_return and v_batch is not null then
    delete from public.production_batch_items where batch_id = v_batch and so_number = p_so;
  end if;
end $function$;
grant execute on function public.unlink_line_from_so(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';
