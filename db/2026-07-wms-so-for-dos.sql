-- Show which Sales Order each received item is for, on the Warehouse Receiving screen.
--
-- The DO↔SO link lives in two places: production_batch_items (the batch was produced for an SO)
-- and sales_order_lines.delivered_do (the SO was stamped as delivered by this DO). Warehouse staff
-- don't have the Sales 'view' permission, so they can't read sales_order_lines directly. This tiny
-- SECURITY DEFINER function returns ONLY the SO number per (DO number, item code) for the given DOs
-- — nothing else — so receiving staff can see the order an incoming item is for.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create or replace function public.wms_so_for_dos(p_do_numbers text[])
  returns table(do_number text, item_code text, so_number text)
  language sql security definer set search_path = public stable as $$
  -- SO via the production batch that fed this delivery line
  select d.do_number, dl.item_code, pbi.so_number
  from public.dispatch_orders d
  join public.dispatch_order_lines dl on dl.dispatch_id = d.id
  join public.production_batch_items pbi on pbi.batch_id = dl.batch_id
  where d.do_number = any (p_do_numbers) and nullif(pbi.so_number, '') is not null
  union
  -- SO stamped as delivered by this DO (bypass / direct / manually linked)
  select sol.delivered_do, sol.item_code, sol.so_number
  from public.sales_order_lines sol
  where sol.delivered_do = any (p_do_numbers) and nullif(sol.so_number, '') is not null
$$;
grant execute on function public.wms_so_for_dos(text[]) to authenticated, service_role;

notify pgrst, 'reload schema';
