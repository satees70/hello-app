-- Cycle-count program. Turn ad-hoc stock counts into systematic coverage: give each item an ABC
-- count class (A = count often, C = count rarely), track when it was last counted, and flag items
-- that are due. The cycle-count page then starts a count for exactly the items that are due.
--
-- Run in the Supabase SQL editor. Safe to re-run.

-- Per-item count class: A / B / C (null = not on the cycle-count program).
alter table public.wms_item_settings add column if not exists count_class text;

-- Last time each item was counted — the newest APPLIED count that included it.
create or replace function public.wms_item_last_counted()
  returns table(item_code text, last_counted timestamptz)
  language sql security definer set search_path = public stable as $$
  select cl.item_code, max(t.applied_at) as last_counted
  from public.wms_count_lines cl
  join public.wms_count_tasks t on t.id = cl.task_id and t.status = 'Applied' and t.applied_at is not null
  group by cl.item_code
$$;
grant execute on function public.wms_item_last_counted() to authenticated;

notify pgrst, 'reload schema';
