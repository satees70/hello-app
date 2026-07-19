-- WMS reorder planning: upgrade the low-stock buy-list from a single hand-entered reorder
-- point to a smarter plan — a target (max) top-up level, a supplier lead time, and a
-- usage-driven suggested reorder level (avg daily use x lead time). This adds two per-item
-- settings columns and a read-only report RPC that returns average daily outbound usage.
--
-- Run in the Supabase SQL editor. Safe to re-run (idempotent).

-- Per-item planning inputs on the existing settings table.
alter table public.wms_item_settings add column if not exists reorder_max numeric;   -- target / top-up (max) level
alter table public.wms_item_settings add column if not exists lead_time_days int;     -- supplier lead time in days

-- Average DAILY usage per item = total outbound qty (picks + dispatches) over the last
-- p_days, divided by p_days. Read-only report helper, gated the same way as the other wms
-- report RPCs (e.g. wms_item_last_counted): SECURITY DEFINER + granted to authenticated,
-- who already need warehouse 'view' to reach the reports page and its settings.
create or replace function public.wms_item_usage(p_days int default 90)
  returns table(item_code text, avg_daily_use numeric)
  language sql security definer set search_path = public stable as $$
  select m.item_code, sum(m.quantity) / greatest(p_days, 1) as avg_daily_use
  from public.wms_stock_moves m
  where m.move_type in ('pick', 'dispatch')
    and m.created_at >= now() - (greatest(p_days, 1) || ' days')::interval
  group by m.item_code
$$;
grant execute on function public.wms_item_usage(int) to authenticated;

notify pgrst, 'reload schema';
