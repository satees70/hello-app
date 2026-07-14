-- WMS checker step, stage B:
--   B1) the checker can correct a picked quantity; a change is sent to Head Office for
--       approval (a clean check with no change still signs off directly, from stage A).
--   B2) customer loading check — a second person tallies the loaded items and signs off.
--
-- Run in the Supabase SQL editor. Safe to re-run. (Requires db/2026-07-wms-order-check.sql.)

-- Record of the checker's verified count per line (set when a correction is approved).
alter table public.wms_order_lines add column if not exists checked_qty numeric;

-- Loading-check stamp on each delivery (dispatch).
alter table public.wms_dispatches add column if not exists load_checked_at timestamptz;
alter table public.wms_dispatches add column if not exists load_checked_by uuid;
alter table public.wms_dispatches add column if not exists load_checked_by_name text;
alter table public.wms_dispatches add column if not exists load_check_note text;

-- ── B1: quantity-correction approval request ─────────────────────────────────────
create table if not exists public.wms_check_qty_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.wms_orders(id) on delete cascade,
  order_no text,
  factory_code text,                 -- set for production orders; null for customer orders
  note text,
  corrections jsonb not null,        -- [{line_id, item_code, description, picked_qty, checked_qty}]
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.wms_check_qty_requests to authenticated, anon, service_role;
grant update, delete on public.wms_check_qty_requests to service_role;
alter table public.wms_check_qty_requests enable row level security;
drop policy if exists wcqr_read on public.wms_check_qty_requests;
create policy wcqr_read on public.wms_check_qty_requests for select
  using (is_ho_or_admin() or requested_by = auth.uid() or (factory_code is not null and factory_code = any(my_factory_codes())));
drop policy if exists wcqr_insert on public.wms_check_qty_requests;
create policy wcqr_insert on public.wms_check_qty_requests for insert
  with check (requested_by = auth.uid() and has_perm('warehouse','edit'));

-- Submit a correction: the checker verified different quantities → goes to HO. Requires a
-- fully-picked order and a checker who did not pick it. Order stays Picked (dispatch locked)
-- until approved.
create or replace function public.wms_submit_check_correction(p_order_id uuid, p_note text, p_corrections jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_order wms_orders; v_name text; v_rid uuid;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to check orders'; end if;
  select * into v_order from wms_orders where id = p_order_id;
  if not found then raise exception 'Order not found'; end if;
  if v_order.status <> 'Picked' then raise exception 'Only a fully-picked order can be checked (this one is %)', v_order.status; end if;
  if v_order.order_no is not null and exists (
       select 1 from wms_stock_moves where move_type='pick' and reference = v_order.order_no and moved_by = auth.uid()) then
    raise exception 'The person who picked this order cannot check it — ask another staff member';
  end if;
  select full_name into v_name from profiles where id = auth.uid();
  insert into public.wms_check_qty_requests (order_id, order_no, factory_code, note, corrections, requested_by, requested_by_name)
    values (p_order_id, v_order.order_no, v_order.factory_code, nullif(p_note,''), coalesce(p_corrections,'[]'::jsonb), auth.uid(), v_name)
    returning id into v_rid;
  return v_rid;
end $$;
grant execute on function public.wms_submit_check_correction(uuid, text, jsonb) to authenticated, anon, service_role;

-- HO approves: record the verified quantities on the lines and mark the order Checked
-- (the checker signed off; HO approved the discrepancy). No automatic stock movement — a
-- genuine physical shortage is reconciled via the Stock Adjustment approval.
create or replace function public.approve_wms_check_correction(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.wms_check_qty_requests; v_name text; el jsonb;
begin
  if not is_ho_or_admin() then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.wms_check_qty_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  for el in select jsonb_array_elements(r.corrections) loop
    update wms_order_lines set checked_qty = (el->>'checked_qty')::numeric where id = nullif(el->>'line_id','')::uuid;
  end loop;
  update wms_orders set status = 'Checked', pick_checked_at = now(), pick_checked_by = r.requested_by,
      pick_checked_by_name = r.requested_by_name,
      pick_check_note = trim(both ' ' from coalesce(r.note,'') || ' (qty corrected · HO-approved)')
    where id = r.order_id and status = 'Picked';
  select full_name into v_name from profiles where id = auth.uid();
  update public.wms_check_qty_requests set status='Approved', reviewed_by=auth.uid(), reviewed_by_name=v_name, reviewed_at=now() where id = p_id;
end $$;
grant execute on function public.approve_wms_check_correction(uuid) to authenticated;

create or replace function public.reject_wms_check_correction(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not is_ho_or_admin() then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from profiles where id = auth.uid();
  update public.wms_check_qty_requests set status='Rejected', reviewed_by=auth.uid(), reviewed_by_name=v_name, reviewed_at=now()
    where id = p_id and status='Pending';
end $$;
grant execute on function public.reject_wms_check_correction(uuid) to authenticated;

-- ── B2: customer loading check ───────────────────────────────────────────────────
-- A second person confirms the loaded items against the delivery/invoice. Must not be the
-- person who did the pick check.
create or replace function public.wms_load_check(p_dispatch_id uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_disp public.wms_dispatches; v_order wms_orders; v_name text;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  select * into v_disp from public.wms_dispatches where id = p_dispatch_id;
  if not found then raise exception 'Delivery not found'; end if;
  select * into v_order from wms_orders where id = v_disp.order_id;
  if v_order.pick_checked_by is not null and v_order.pick_checked_by = auth.uid() then
    raise exception 'The person who checked the pick cannot also do the loading check — ask another staff member';
  end if;
  select full_name into v_name from profiles where id = auth.uid();
  update public.wms_dispatches set load_checked_at=now(), load_checked_by=auth.uid(), load_checked_by_name=v_name, load_check_note=nullif(p_note,'')
    where id = p_dispatch_id;
end $$;
grant execute on function public.wms_load_check(uuid, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
