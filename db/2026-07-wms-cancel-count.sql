-- Stock counts: allow cancelling a count that is still Counting or in Review (e.g. a trial run,
-- a duplicate, or one that will never be finished). A count that was already Applied cannot be
-- cancelled (its stock corrections are done). Cancelling does NOT change any stock.
--
-- Run in the Supabase SQL editor. Safe to re-run.

alter table public.wms_count_tasks add column if not exists cancelled_at timestamptz;
alter table public.wms_count_tasks add column if not exists cancelled_by uuid;
alter table public.wms_count_tasks add column if not exists cancelled_by_name text;

create or replace function public.wms_cancel_count(p_task_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text; v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  select status into v_status from public.wms_count_tasks where id = p_task_id;
  if v_status is null then raise exception 'Count not found'; end if;
  if v_status = 'Applied' then raise exception 'This count was already applied and cannot be cancelled'; end if;
  if v_status = 'Cancelled' then return; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.wms_count_tasks
     set status = 'Cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancelled_by_name = v_name
   where id = p_task_id and status <> 'Applied';
end $$;
grant execute on function public.wms_cancel_count(uuid) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
