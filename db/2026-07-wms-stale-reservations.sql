-- WMS stale reservations: surface + release stock locked by abandoned orders.
-- ----------------------------------------------------------------------------
-- When an order is Released it RESERVES stock (wms_reservations). If it's then never
-- picked, that reservation stays 'active' forever and hides the physical stock from
-- every other order ("no stock" even though it's on the shelf). Worse, old orders drop
-- off the 100-row Orders list, so staff can't even find them to cancel. This adds:
--   * wms_stale_reserved_orders(hours) — lists orders sitting Reserved/Released/Picking
--     with active reservations older than N hours (regardless of the UI's 100-row limit),
--     with how much stock each is locking.
--   * wms_release_order(order) — Head-Office action: release those reservations + cancel
--     the order (same effect as the app's Cancel, but reachable + audited).
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- ============================================================================

alter table public.wms_reservations add column if not exists released_by uuid;   -- who released it (audit)

-- List stale reserved orders (Head Office / warehouse view).
create or replace function public.wms_stale_reserved_orders(p_hours int default 24)
returns table(
  order_id uuid, order_no text, status text, customer_name text, source text,
  created_at timestamptz, pick_started_at timestamptz, assigned_to_name text,
  reserved_lines bigint, reserved_qty numeric, reserved_since timestamptz, picked_any boolean
) language plpgsql security definer set search_path = public stable as $$
begin
  if not (public.has_perm('warehouse','view') or public.is_ho_or_admin()) then
    raise exception 'Not allowed';
  end if;
  return query
    select o.id, o.order_no, o.status, o.customer_name, o.source, o.created_at, o.pick_started_at, o.assigned_to_name,
      count(r.*)::bigint as reserved_lines, sum(r.qty)::numeric as reserved_qty,
      min(r.created_at) as reserved_since,
      exists(select 1 from public.wms_order_lines l where l.order_id = o.id and coalesce(l.qty_picked,0) > 0) as picked_any
    from public.wms_orders o
    join public.wms_reservations r on r.order_id = o.id and r.status = 'active'
    where o.status in ('Reserved','Released','Picking')
    group by o.id, o.order_no, o.status, o.customer_name, o.source, o.created_at, o.pick_started_at, o.assigned_to_name
    having min(r.created_at) < now() - make_interval(hours => greatest(coalesce(p_hours,24), 0))
    order by min(r.created_at);
end $$;
grant execute on function public.wms_stale_reserved_orders(int) to authenticated;

-- Release a stale order's reservations + cancel it (Head Office only, audited).
create or replace function public.wms_release_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can release a stale order'; end if;
  update public.wms_reservations set status='released', released_at=now(), released_by=auth.uid()
    where order_id = p_order_id and status='active';
  update public.wms_orders set status='Cancelled' where id = p_order_id;
end $$;
grant execute on function public.wms_release_order(uuid) to authenticated;

notify pgrst, 'reload schema';
