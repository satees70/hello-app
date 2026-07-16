-- WMS picking: re-pick the OUTSTANDING (no-stock) part of a line once stock arrives.
-- When a picker confirms "no stock", the line's ordered qty is shrunk to what was picked and
-- the shortfall is kept in no_stock_qty (so the order could ship what it had). This restores
-- that outstanding quantity, clears the no-stock mark, and reopens the order for picking — so
-- the balance can be picked and dispatched in a later run (multiple partial deliveries).
--
-- Any warehouse picker (warehouse edit) can do this. Run in the Supabase SQL editor. Safe to re-run.

create or replace function public.wms_reopen_line(p_line_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_line wms_order_lines;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  select * into v_line from wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  if not coalesce(v_line.no_stock, false) or coalesce(v_line.no_stock_qty, 0) <= 0 then
    raise exception 'This line has no outstanding (no-stock) quantity to re-pick';
  end if;

  -- Restore the outstanding quantity and clear the no-stock mark so it becomes pickable again.
  update wms_order_lines
    set quantity = coalesce(qty_picked, 0) + no_stock_qty,
        no_stock = false, no_stock_qty = null, no_stock_by = null, no_stock_by_name = null,
        no_stock_at = null, no_stock_note = null
    where id = p_line_id;

  -- Reopen the order for picking (everything already picked / dispatched stays as it is).
  update wms_orders set status = 'Picking'
    where id = v_line.order_id and status in ('Picked','Checked','Partially Dispatched','Dispatched');
end $$;
grant execute on function public.wms_reopen_line(uuid) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
