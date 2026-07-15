-- Add the delivery date to the "not on any delivery schedule" candidate list so it's easier to
-- spot stale orders. (PO cancel date is not captured on sales-order lines — it only exists in the
-- Delivery-Schedule Excel, which these un-scheduled orders never went through — so it can't be
-- shown here.) Run in the Supabase SQL editor. Safe to re-run.

drop function if exists public.so_lines_unscheduled();
create or replace function public.so_lines_unscheduled()
returns table (line_id uuid, so_number text, customer_name text, item_code text, description text,
               factory_code text, delivery_date text, ordered_qty numeric, delivered_qty numeric, balance numeric)
language sql security definer set search_path = public as $$
  select sol.id, sol.so_number, sol.customer_name, sol.item_code, sol.description, sol.factory_code,
         sol.delivery_date::text,
         coalesce(sol.outstanding_qty, sol.quantity, 0),
         coalesce(sol.delivered_qty, 0),
         greatest(0, coalesce(sol.outstanding_qty, sol.quantity, 0) - coalesce(sol.delivered_qty, 0))
  from public.sales_order_lines sol
  where greatest(0, coalesce(sol.outstanding_qty, sol.quantity, 0) - coalesce(sol.delivered_qty, 0)) > 0
    and sol.balance_cancelled_at is null
    and not exists (select 1 from public.delivery_schedule ds where ds.so_number = sol.so_number and ds.route is not null)
    and (my_factory_code() = 'HEAD_OFFICE' or sol.factory_code = any (my_factory_codes()) or sol.factory_code is null)
  order by sol.so_number, sol.item_code;
$$;
grant execute on function public.so_lines_unscheduled() to authenticated, anon, service_role;

notify pgrst, 'reload schema';
