-- WMS picking KPI: assign an order to a picker, and record pick start/end times so a
-- picker's throughput can be traced. Start/end are captured automatically from the order's
-- status (start = when picking begins, end = when fully Picked) — no change to the pick RPC.
--
-- Run in the Supabase SQL editor. Safe to re-run.

alter table public.wms_orders add column if not exists assigned_to uuid;
alter table public.wms_orders add column if not exists assigned_to_name text;
alter table public.wms_orders add column if not exists assigned_at timestamptz;
alter table public.wms_orders add column if not exists pick_started_at timestamptz;
alter table public.wms_orders add column if not exists pick_completed_at timestamptz;

-- Assign (or clear) the picker for an order.
create or replace function public.wms_assign_order(p_order_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to assign'; end if;
  if p_user_id is null then
    update wms_orders set assigned_to = null, assigned_to_name = null, assigned_at = null where id = p_order_id;
    return;
  end if;
  select full_name into v_name from profiles where id = p_user_id;
  update wms_orders set assigned_to = p_user_id, assigned_to_name = v_name, assigned_at = now() where id = p_order_id;
end $$;
grant execute on function public.wms_assign_order(uuid, uuid) to authenticated, anon, service_role;

-- Auto start/end timestamps from status transitions.
create or replace function public.tg_wms_pick_times() returns trigger language plpgsql as $$
begin
  if new.pick_started_at is null and new.status in ('Picking','Picked') and coalesce(old.status,'') not in ('Picking','Picked') then
    new.pick_started_at := now();
  end if;
  if new.pick_completed_at is null and new.status = 'Picked' and old.status is distinct from 'Picked' then
    new.pick_completed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists wms_pick_times on public.wms_orders;
create trigger wms_pick_times before update on public.wms_orders
  for each row execute function public.tg_wms_pick_times();

notify pgrst, 'reload schema';
