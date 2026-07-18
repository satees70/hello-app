-- Manual fill when the warehouse is short — with Head-Office (HOD) approval.
--
-- When picking, the system only lets a picker take what's recorded in the bins. Sometimes the
-- physical stock is really there but not in the system (e.g. a receipt wasn't booked), and the
-- picker needs to fulfil the order anyway. This lets the picker enter the quantity to fill; it is
-- sent to Head Office, and only once HOD approves is it booked as picked.
--
-- On approval the quantity is credited to the order line (qty_picked += qty) and a 'pick' move is
-- logged with a "Manual fill (HOD approved)" reference. It does NOT touch bin quantities — the
-- stock was never recorded, so nothing is decremented and no bin can go negative; the move is the
-- audit trail of the off-book pick.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create table if not exists public.wms_manual_pick_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null,
  line_id uuid not null,
  order_no text,
  item_code text,
  description text,
  uom text,
  qty numeric not null,
  note text,
  status text not null default 'Pending',
  requested_by uuid,
  requested_by_name text,
  reviewed_by uuid,
  reviewed_by_name text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.wms_manual_pick_requests enable row level security;

-- Read: warehouse viewers / Head Office (so the picker sees their own pending flag and HOD sees the queue).
drop policy if exists wms_manual_pick_read on public.wms_manual_pick_requests;
create policy wms_manual_pick_read on public.wms_manual_pick_requests for select to authenticated
  using (has_perm('warehouse', 'view') or requested_by = auth.uid());
-- Writes go only through the SECURITY DEFINER RPCs below (no direct insert/update policy).

-- Picker asks Head Office to let them fill a quantity that isn't in the system.
create or replace function public.request_wms_manual_pick(p_line_id uuid, p_qty numeric, p_note text default null)
  returns uuid language plpgsql security definer set search_path = public as $$
declare v_line public.wms_order_lines; v_order public.wms_orders; v_name text; v_rem numeric; v_id uuid;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to pick warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Fill quantity must be greater than zero'; end if;
  select * into v_line from public.wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from public.wms_orders where id = v_line.order_id;
  v_rem := coalesce(v_line.quantity, 0) - coalesce(v_line.qty_picked, 0);
  if p_qty > v_rem then raise exception 'Only % still outstanding on this line', v_rem; end if;
  if exists (select 1 from public.wms_manual_pick_requests where line_id = p_line_id and status = 'Pending') then
    raise exception 'A manual fill is already pending approval for this item';
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.wms_manual_pick_requests (order_id, line_id, order_no, item_code, description, uom, qty, note, requested_by, requested_by_name)
  values (v_line.order_id, p_line_id, v_order.order_no, v_line.item_code, v_line.description, v_line.uom, p_qty, nullif(btrim(p_note), ''), auth.uid(), v_name)
  returning id into v_id;

  insert into public.notifications (factory_code, type, title, body, link, ref)
  values ('HEAD_OFFICE', 'wms', '🖐 Manual fill needs approval',
    coalesce(v_order.order_no, 'Order') || ' — ' || coalesce(v_line.item_code, '') || ' × ' || p_qty::text
      || ' (picker ' || coalesce(v_name, '?') || ')' || case when nullif(btrim(p_note), '') is not null then ' · ' || btrim(p_note) else '' end,
    '/wms/approvals', 'manualpick:' || v_id::text)
  on conflict (ref) do nothing;
  return v_id;
end $$;
grant execute on function public.request_wms_manual_pick(uuid, numeric, text) to authenticated;

-- Head Office approves — book the fill as picked.
create or replace function public.approve_wms_manual_pick(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_req public.wms_manual_pick_requests; v_line public.wms_order_lines; v_order public.wms_orders;
  v_name text; v_book numeric; v_rem numeric;
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can approve a manual fill'; end if;
  select * into v_req from public.wms_manual_pick_requests where id = p_id;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'Pending' then raise exception 'This request was already handled'; end if;
  select * into v_line from public.wms_order_lines where id = v_req.line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from public.wms_orders where id = v_line.order_id;
  select full_name into v_name from public.profiles where id = auth.uid();

  v_rem  := coalesce(v_line.quantity, 0) - coalesce(v_line.qty_picked, 0);
  v_book := least(coalesce(v_req.qty, 0), greatest(v_rem, 0));   -- never over-pick the line

  if v_book > 0 then
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      batch_no, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'pick', v_line.item_id, v_line.item_code, v_line.description, '', v_book,
      coalesce(v_order.order_no, '') || ' · Manual fill (HOD approved by ' || coalesce(v_name, 'HO') || ')', auth.uid(), v_name);

    update public.wms_order_lines
      set qty_picked = coalesce(qty_picked, 0) + v_book,
          no_stock = false, no_stock_qty = null, no_stock_by = null, no_stock_by_name = null, no_stock_at = null, no_stock_note = null
      where id = v_req.line_id;

    update public.wms_orders o set status = case
        when not exists (select 1 from public.wms_order_lines wl where wl.order_id = o.id and wl.qty_picked < wl.quantity) then 'Picked'
        when exists (select 1 from public.wms_order_lines wl where wl.order_id = o.id and wl.qty_picked > 0) then 'Picking'
        else o.status end
      where o.id = v_line.order_id;
  end if;

  update public.wms_manual_pick_requests
    set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;

  -- tell the picker it's cleared
  if v_order.assigned_to is not null then
    insert into public.notifications (factory_code, user_id, type, title, body, link, ref)
    values ('8BT', v_order.assigned_to, 'wms', '✅ Manual fill approved',
      coalesce(v_order.order_no, 'Order') || ' — ' || coalesce(v_line.item_code, '') || ' × ' || v_book::text || ' booked as picked.',
      '/wms/pick/' || v_line.order_id::text, 'manualpick_ok:' || p_id::text)
    on conflict (ref) do nothing;
  end if;
end $$;
grant execute on function public.approve_wms_manual_pick(uuid) to authenticated;

create or replace function public.reject_wms_manual_pick(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_req public.wms_manual_pick_requests; v_order public.wms_orders; v_name text;
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can reject a manual fill'; end if;
  select * into v_req from public.wms_manual_pick_requests where id = p_id;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'Pending' then raise exception 'This request was already handled'; end if;
  select * into v_order from public.wms_orders where id = v_req.order_id;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.wms_manual_pick_requests
    set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
  if v_order.assigned_to is not null then
    insert into public.notifications (factory_code, user_id, type, title, body, link, ref)
    values ('8BT', v_order.assigned_to, 'wms', '❌ Manual fill rejected',
      coalesce(v_req.order_no, 'Order') || ' — ' || coalesce(v_req.item_code, '') || ' manual fill was not approved.',
      '/wms/pick/' || v_req.order_id::text, 'manualpick_no:' || p_id::text)
    on conflict (ref) do nothing;
  end if;
end $$;
grant execute on function public.reject_wms_manual_pick(uuid) to authenticated;

notify pgrst, 'reload schema';
