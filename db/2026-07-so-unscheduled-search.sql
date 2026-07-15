-- The "not on any delivery schedule" candidate list was capped at 1000 rows and ordered by SO,
-- so orders past the cut-off (e.g. SO-40791) never loaded and couldn't be found. Add a server-side
-- search parameter so a typed search queries the whole database, and cap the un-searched view.
--
-- Depends on db/2026-07-so-unscheduled-cancel.sql. Run in the Supabase SQL editor. Safe to re-run.

drop function if exists public.so_lines_unscheduled();
drop function if exists public.so_lines_unscheduled(text);
create or replace function public.so_lines_unscheduled(p_search text default null)
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
    and (coalesce(p_search,'') = ''
         or sol.so_number      ilike '%'||p_search||'%'
         or sol.customer_name  ilike '%'||p_search||'%'
         or sol.item_code      ilike '%'||p_search||'%'
         or sol.description    ilike '%'||p_search||'%'
         or sol.factory_code   ilike '%'||p_search||'%'
         or sol.delivery_date::text ilike '%'||p_search||'%')
  order by sol.so_number, sol.item_code
  limit 800;
$$;
grant execute on function public.so_lines_unscheduled(text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
