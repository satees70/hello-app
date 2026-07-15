-- Stock counts: add a "Stop counting" step (Counting → Review, records when it finished so a
-- duration can be shown), and require a manager (Head Office / admin — "HOD") to APPLY the
-- adjustments that correct stock. Run in the Supabase SQL editor. Safe to re-run.

alter table public.wms_count_tasks add column if not exists completed_at timestamptz;
alter table public.wms_count_tasks add column if not exists completed_by uuid;
alter table public.wms_count_tasks add column if not exists completed_by_name text;

-- Counter marks counting finished → the count goes to Review, waiting for a manager to apply.
create or replace function public.wms_stop_count(p_task_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.wms_count_tasks
    set status='Review', completed_at=coalesce(completed_at, now()), completed_by=auth.uid(), completed_by_name=v_name
    where id = p_task_id and status = 'Counting';
end $$;
grant execute on function public.wms_stop_count(uuid) to authenticated, anon, service_role;

-- Apply the corrections — now HOD-only (Head Office / admin). Body unchanged except the guard.
create or replace function public.wms_apply_count(p_task_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_task wms_count_tasks; v_name text; r record; v_ref text; v_old numeric; v_delta numeric; v_applied int := 0;
begin
  if not is_ho_or_admin() then raise exception 'Only Head Office / a manager can apply the stock adjustments'; end if;
  select * into v_task from wms_count_tasks where id = p_task_id;
  if not found then raise exception 'Count not found'; end if;
  if v_task.status = 'Applied' then raise exception 'This count was already applied'; end if;
  select full_name into v_name from profiles where id = auth.uid();
  v_ref := 'Cycle count ' || coalesce(v_task.count_no, '');

  for r in select * from wms_count_lines where task_id = p_task_id and counted_qty is not null and skip = false loop
    select quantity into v_old from wms_stock
      where warehouse_code='8BT' and item_code=r.item_code and location_id=r.location_id and batch_no=r.batch_no;
    v_old := coalesce(v_old, 0);
    v_delta := r.counted_qty - v_old;
    continue when v_delta = 0;

    if r.counted_qty = 0 then
      delete from wms_stock where warehouse_code='8BT' and item_code=r.item_code and location_id=r.location_id and batch_no=r.batch_no;
    else
      insert into wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity)
      values ('8BT', r.item_id, r.item_code, r.description, r.location_id, r.location_code, r.batch_no, r.exp_date, r.counted_qty)
      on conflict (warehouse_code, item_code, location_id, batch_no)
      do update set quantity = excluded.quantity, exp_date = coalesce(wms_stock.exp_date, excluded.exp_date), updated_at = now();
    end if;

    insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT','adjust', r.item_id, r.item_code, r.description,
      case when v_delta < 0 then r.location_id end, case when v_delta < 0 then r.location_code end,
      case when v_delta > 0 then r.location_id end, case when v_delta > 0 then r.location_code end,
      r.batch_no, r.exp_date, abs(v_delta), v_ref, auth.uid(), v_name);
    v_applied := v_applied + 1;
  end loop;

  update wms_count_tasks set status='Applied', applied_by=auth.uid(), applied_by_name=v_name, applied_at=now() where id = p_task_id;
  return jsonb_build_object('applied', v_applied);
end $$;
grant execute on function public.wms_apply_count(uuid) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
