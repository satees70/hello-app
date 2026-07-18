-- Manual fill v2 — capture bin (location) + batch + qty, and book a REAL pick OUT on approval.
--
-- v1 credited the pick off-book (no bin/batch) so it never showed in the stock card. Now the picker
-- says exactly WHERE they took it from (bin + batch) and HOW MUCH; on Head-Office approval it books a
-- 'pick' movement OUT of that bin/batch, so it posts in the stock card as an OUT. If that bin held
-- less than was filled, it goes negative by exactly the amount that wasn't in the system — the precise
-- discrepancy for inventory to reconcile with a stock count.
--
-- Run in the Supabase SQL editor. Safe to re-run. Depends on db/2026-07-wms-manual-pick.sql.

alter table public.wms_manual_pick_requests add column if not exists location_id uuid;
alter table public.wms_manual_pick_requests add column if not exists location_code text;
alter table public.wms_manual_pick_requests add column if not exists batch text;

-- Old signature (no bin/batch) is replaced.
drop function if exists public.request_wms_manual_pick(uuid, numeric, text);

create or replace function public.request_wms_manual_pick(p_line_id uuid, p_qty numeric, p_location_id uuid, p_batch text default null, p_note text default null)
  returns uuid language plpgsql security definer set search_path = public as $$
declare v_line public.wms_order_lines; v_order public.wms_orders; v_name text; v_rem numeric; v_loc text; v_id uuid; v_batch text := coalesce(nullif(btrim(p_batch), ''), '');
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to pick warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Fill quantity must be greater than zero'; end if;
  if p_location_id is null then raise exception 'Choose the bin you are filling from'; end if;
  select * into v_line from public.wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from public.wms_orders where id = v_line.order_id;
  v_rem := coalesce(v_line.quantity, 0) - coalesce(v_line.qty_picked, 0);
  if p_qty > v_rem then raise exception 'Only % still outstanding on this line', v_rem; end if;
  if exists (select 1 from public.wms_manual_pick_requests where line_id = p_line_id and status = 'Pending') then
    raise exception 'A manual fill is already pending approval for this item';
  end if;
  select code into v_loc from public.wms_locations where id = p_location_id;
  if v_loc is null then raise exception 'Bin not found'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.wms_manual_pick_requests (order_id, line_id, order_no, item_code, description, uom, qty, location_id, location_code, batch, note, requested_by, requested_by_name)
  values (v_line.order_id, p_line_id, v_order.order_no, v_line.item_code, v_line.description, v_line.uom, p_qty, p_location_id, v_loc, v_batch, nullif(btrim(p_note), ''), auth.uid(), v_name)
  returning id into v_id;

  insert into public.notifications (factory_code, type, title, body, link, ref)
  values ('HEAD_OFFICE', 'wms', '🖐 Manual fill needs approval',
    coalesce(v_order.order_no, 'Order') || ' — ' || coalesce(v_line.item_code, '') || ' × ' || p_qty::text
      || ' from ' || v_loc || case when v_batch <> '' then ' · b:' || v_batch else '' end
      || ' (picker ' || coalesce(v_name, '?') || ')' || case when nullif(btrim(p_note), '') is not null then ' · ' || btrim(p_note) else '' end,
    '/wms/approvals', 'manualpick:' || v_id::text)
  on conflict (ref) do nothing;
  return v_id;
end $$;
grant execute on function public.request_wms_manual_pick(uuid, numeric, uuid, text, text) to authenticated;

create or replace function public.approve_wms_manual_pick(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_req public.wms_manual_pick_requests; v_line public.wms_order_lines; v_order public.wms_orders;
  v_name text; v_book numeric; v_rem numeric; v_batch text; v_exists boolean;
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can approve a manual fill'; end if;
  select * into v_req from public.wms_manual_pick_requests where id = p_id;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'Pending' then raise exception 'This request was already handled'; end if;
  select * into v_line from public.wms_order_lines where id = v_req.line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from public.wms_orders where id = v_line.order_id;
  select full_name into v_name from public.profiles where id = auth.uid();

  v_rem   := coalesce(v_line.quantity, 0) - coalesce(v_line.qty_picked, 0);
  v_book  := least(coalesce(v_req.qty, 0), greatest(v_rem, 0));   -- never over-pick the line
  v_batch := coalesce(v_req.batch, '');

  if v_book > 0 and v_req.location_id is not null then
    -- Real pick OUT of the chosen bin/batch (goes negative if the bin held less than filled).
    select true into v_exists from public.wms_stock
      where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = v_req.location_id and batch_no = v_batch limit 1;
    if v_exists then
      update public.wms_stock set quantity = quantity - v_book, updated_at = now()
        where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = v_req.location_id and batch_no = v_batch;
    else
      insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, quantity, uom)
      values ('8BT', v_line.item_id, v_line.item_code, v_line.description, v_req.location_id, v_req.location_code, v_batch, -v_book, v_line.uom);
    end if;

    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, batch_no, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'pick', v_line.item_id, v_line.item_code, v_line.description,
      v_req.location_id, v_req.location_code, v_batch, v_book,
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

  if v_order.assigned_to is not null then
    insert into public.notifications (factory_code, user_id, type, title, body, link, ref)
    values ('8BT', v_order.assigned_to, 'wms', '✅ Manual fill approved',
      coalesce(v_order.order_no, 'Order') || ' — ' || coalesce(v_line.item_code, '') || ' × ' || v_book::text
        || ' from ' || coalesce(v_req.location_code, '') || ' booked as picked.',
      '/wms/pick/' || v_line.order_id::text, 'manualpick_ok:' || p_id::text)
    on conflict (ref) do nothing;
  end if;
end $$;
grant execute on function public.approve_wms_manual_pick(uuid) to authenticated;

notify pgrst, 'reload schema';
