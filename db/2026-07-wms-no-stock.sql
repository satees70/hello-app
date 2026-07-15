-- WMS picking: let the picker CONFIRM there's no stock for a line (or its remaining part),
-- so an order isn't stuck when a pack is out of stock. The confirmed shortfall is recorded,
-- the line's ordered qty is reduced to what was actually picked, and the order can proceed
-- to check/dispatch with only what's available. Works for partial picks too (pick what's
-- there, then confirm no-stock on the rest).
--
-- Run in the Supabase SQL editor. Safe to re-run.

alter table public.wms_order_lines add column if not exists no_stock boolean not null default false;
alter table public.wms_order_lines add column if not exists no_stock_qty numeric;   -- confirmed shortfall
alter table public.wms_order_lines add column if not exists no_stock_by uuid;
alter table public.wms_order_lines add column if not exists no_stock_by_name text;
alter table public.wms_order_lines add column if not exists no_stock_at timestamptz;
alter table public.wms_order_lines add column if not exists no_stock_note text;

create or replace function public.wms_confirm_no_stock(p_line_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_line wms_order_lines; v_order wms_orders; v_name text; v_short numeric;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  select * into v_line from wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from wms_orders where id = v_line.order_id;
  if v_order.status not in ('Reserved','Released','Picking','Picked') then
    raise exception 'Can only mark no-stock while the order is being picked (status is %)', v_order.status;
  end if;
  v_short := v_line.quantity - coalesce(v_line.qty_picked, 0);
  if v_short <= 0 then raise exception 'This line is already fully picked'; end if;

  -- Record the shortfall and shrink the order line to what was actually picked, so the order
  -- can move on and the DO ships only what's available.
  update wms_order_lines
    set no_stock = true, no_stock_qty = v_short, no_stock_by = auth.uid(), no_stock_by_name = v_name,
        no_stock_at = now(), no_stock_note = nullif(p_note, ''), quantity = coalesce(qty_picked, 0)
    where id = p_line_id;
  select full_name into v_name from profiles where id = auth.uid();
  update wms_order_lines set no_stock_by_name = v_name where id = p_line_id;

  -- If every line is now fully picked (or confirmed no-stock), the order is ready to check.
  update wms_orders o set status = 'Picked'
    where o.id = v_line.order_id and o.status in ('Reserved','Released','Picking')
      and not exists (select 1 from wms_order_lines l where l.order_id = o.id and l.qty_picked < l.quantity);
end $$;
grant execute on function public.wms_confirm_no_stock(uuid, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
