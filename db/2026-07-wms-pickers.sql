-- WMS pickers: flag which staff (user accounts) are pickers, so an order is assigned from a
-- short curated list instead of every user. Plus an optional explicit "Start picking" so the
-- KPI timer can include walk time (otherwise it auto-starts on the first pick).
--
-- Run in the Supabase SQL editor. Safe to re-run. (Requires db/2026-07-wms-picker-kpi.sql.)

alter table public.profiles add column if not exists warehouse_picker boolean not null default false;

-- The flagged pickers (short list) for the assign dropdown — any warehouse user can read it,
-- via this definer function, without exposing the whole profiles table.
create or replace function public.wms_pickers()
returns table (id uuid, full_name text) language sql security definer set search_path = public as $$
  select id, full_name from public.profiles where warehouse_picker = true order by full_name
$$;
grant execute on function public.wms_pickers() to authenticated, anon, service_role;

-- All users + their picker flag, for the "Manage pickers" tick list (supervisors only).
create or replace function public.wms_users_for_picker()
returns table (id uuid, full_name text, is_picker boolean) language plpgsql security definer set search_path = public as $$
begin
  if not (is_ho_or_admin() or has_perm('warehouse','edit')) then raise exception 'Not allowed'; end if;
  return query select p.id, p.full_name, coalesce(p.warehouse_picker, false) from public.profiles p order by p.full_name;
end $$;
grant execute on function public.wms_users_for_picker() to authenticated, anon, service_role;

create or replace function public.wms_set_picker(p_user_id uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (is_ho_or_admin() or has_perm('warehouse','edit')) then raise exception 'Not allowed'; end if;
  update public.profiles set warehouse_picker = coalesce(p_on, false) where id = p_user_id;
end $$;
grant execute on function public.wms_set_picker(uuid, boolean) to authenticated, anon, service_role;

-- Optional explicit start (include walk time); otherwise the timer auto-starts on first pick.
create or replace function public.wms_start_picking(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  update wms_orders set pick_started_at = coalesce(pick_started_at, now())
    where id = p_order_id and status in ('Reserved','Released','Picking');
end $$;
grant execute on function public.wms_start_picking(uuid) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
