-- WMS: Cycle Counting / Stock Takes. Run in the Supabase SQL editor. Idempotent.
-- Builds on wms_stock + wms_stock_moves. Corrections are logged 'adjust' moves.

create sequence if not exists wms_count_seq;

create table if not exists public.wms_count_tasks (
  id uuid primary key default gen_random_uuid(),
  warehouse_code text not null default '8BT',
  count_no text,
  name text,
  scope_type text not null default 'full' check (scope_type in ('full','bins','zones','items')),
  scope jsonb,
  blind boolean not null default false,
  status text not null default 'Counting' check (status in ('Counting','Review','Applied','Cancelled')),
  note text,
  created_by uuid, created_by_name text, created_at timestamptz not null default now(),
  applied_by uuid, applied_by_name text, applied_at timestamptz
);
create index if not exists wms_count_tasks_status on public.wms_count_tasks(status, created_at desc);

create table if not exists public.wms_count_lines (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.wms_count_tasks(id) on delete cascade,
  location_id uuid references public.wms_locations(id),
  location_code text not null,
  item_id uuid references public.items(id),
  item_code text not null,
  description text,
  batch_no text not null default '',
  exp_date date,
  expected_qty numeric not null default 0,
  counted_qty numeric,
  is_unexpected boolean not null default false,
  skip boolean not null default false,
  counted_by uuid, counted_by_name text, counted_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists wms_count_lines_task on public.wms_count_lines(task_id);
create index if not exists wms_count_lines_loc on public.wms_count_lines(location_id);

grant select, insert, update, delete on public.wms_count_tasks, public.wms_count_lines to authenticated, anon, service_role;
grant usage on sequence wms_count_seq to authenticated, anon, service_role;
alter table public.wms_count_tasks enable row level security;
alter table public.wms_count_lines enable row level security;
do $$ declare t text; begin
  foreach t in array array['wms_count_tasks','wms_count_lines'] loop
    execute format('drop policy if exists %I_read on public.%I', t, t);
    execute format('drop policy if exists %I_write on public.%I', t, t);
    execute format('create policy %I_read on public.%I for select using (has_perm(''warehouse'',''view''))', t, t);
    execute format('create policy %I_write on public.%I for all using (has_perm(''warehouse'',''edit'')) with check (has_perm(''warehouse'',''edit''))', t, t);
  end loop;
end $$;

-- Create a count task and snapshot the expected stock lines for its scope (excludes
-- the GOODS-IN staging bin — that's not shelved yet). Returns the new task id.
create or replace function public.wms_start_count(p_name text, p_scope_type text, p_scope text[], p_blind boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_no text; v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to start a count'; end if;
  select full_name into v_name from profiles where id = auth.uid();
  v_no := 'CC-' || lpad(nextval('wms_count_seq')::text, 6, '0');
  insert into wms_count_tasks (count_no, name, scope_type, scope, blind, created_by, created_by_name)
    values (v_no, nullif(p_name,''), p_scope_type, to_jsonb(coalesce(p_scope, array[]::text[])), coalesce(p_blind,false), auth.uid(), v_name)
    returning id into v_id;
  insert into wms_count_lines (task_id, location_id, location_code, item_id, item_code, description, batch_no, exp_date, expected_qty)
    select v_id, s.location_id, s.location_code, s.item_id, s.item_code, s.description, s.batch_no, s.exp_date, s.quantity
    from wms_stock s join wms_locations l on l.id = s.location_id
    where s.warehouse_code = '8BT' and s.quantity > 0 and l.location_type <> 'STAGE'
      and ( p_scope_type = 'full'
         or (p_scope_type = 'bins'  and s.location_code = any(p_scope))
         or (p_scope_type = 'zones' and l.aisle = any(p_scope))
         or (p_scope_type = 'items' and s.item_code = any(p_scope)) );
  return v_id;
end $$;
grant execute on function public.wms_start_count(text, text, text[], boolean) to authenticated, anon, service_role;

-- Apply a reviewed count: for every counted, non-skipped line set the stock to the
-- counted qty and log an 'adjust' move referencing the count number. Uncounted lines
-- are ignored (never zeroed). Marks the task Applied.
create or replace function public.wms_apply_count(p_task_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_task wms_count_tasks; v_name text; r record; v_ref text; v_old numeric; v_delta numeric; v_applied int := 0;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to apply a count'; end if;
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
