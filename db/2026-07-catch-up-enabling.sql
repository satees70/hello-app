-- ============================================================================
-- CATCH-UP: all pending "enabling" migrations in one block. Paste into the Supabase
-- SQL editor and Run once. Every statement is idempotent / safe to re-run, so it's
-- fine even if some parts were already applied. Ordered so dependencies come first.
--   1) Cancel a stock count
--   2) Received-on-paper requests (whole DO)   [base — needed by 3]
--   3) Received-on-paper requests per item line
--   4) PENDING staging bin
--   5) SQL GRN number on Purchase Orders
-- (The one-time "mark old DOs received on paper" data backfill is separate — run that on its own.)
-- ============================================================================


-- 1) STOCK COUNT — cancel a Counting/Review count -----------------------------
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


-- 2) RECEIVED ON PAPER — request/approve (whole DO) ---------------------------
create table if not exists public.do_paper_receipt_requests (
  id uuid primary key default gen_random_uuid(),
  dispatch_id uuid,
  do_number text,
  factory_code text,
  reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.do_paper_receipt_requests to authenticated, anon, service_role;
grant update, delete on public.do_paper_receipt_requests to service_role;
alter table public.do_paper_receipt_requests enable row level security;

drop policy if exists dopr_read on public.do_paper_receipt_requests;
create policy dopr_read on public.do_paper_receipt_requests for select using (
  coalesce((select warehouse_user from public.profiles where id = auth.uid()), false)
  or public.is_ho_or_admin() or requested_by = auth.uid()
);
drop policy if exists dopr_insert on public.do_paper_receipt_requests;
create policy dopr_insert on public.do_paper_receipt_requests for insert with check (requested_by = auth.uid());

create or replace function public.request_do_paper_receipt(p_dispatch_id uuid, p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_do text; v_fac text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff can request a paper receipt';
  end if;
  if p_dispatch_id is null then raise exception 'No delivery order to receive'; end if;
  if exists (select 1 from public.do_paper_receipt_requests where dispatch_id = p_dispatch_id and status = 'Pending') then
    raise exception 'A paper-receipt request is already pending for this delivery order';
  end if;
  select do_number, factory_code into v_do, v_fac from public.dispatch_orders where id = p_dispatch_id;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.do_paper_receipt_requests (dispatch_id, do_number, factory_code, reason, requested_by, requested_by_name)
  values (p_dispatch_id, v_do, v_fac, nullif(btrim(p_reason), ''), auth.uid(), v_name);
end $$;
grant execute on function public.request_do_paper_receipt(uuid, text) to authenticated, anon, service_role;

create or replace function public.reject_do_paper_receipt(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can reject a paper receipt'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.do_paper_receipt_requests
    set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
    where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_do_paper_receipt(uuid) to authenticated, anon, service_role;


-- 3) RECEIVED ON PAPER — per item line + approve (handles line OR whole DO) ----
alter table public.do_paper_receipt_requests add column if not exists line_id uuid;
alter table public.do_paper_receipt_requests add column if not exists line_kind text;   -- 'fg' | 'return'
alter table public.do_paper_receipt_requests add column if not exists item_code text;

create or replace function public.request_do_paper_line_receipt(p_line_id uuid, p_kind text default 'fg', p_reason text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_do uuid; v_no text; v_fac text; v_item text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff can request a paper receipt';
  end if;
  if p_line_id is null then raise exception 'No item line'; end if;
  if p_kind = 'return' then
    select dispatch_id, item_code into v_do, v_item from public.material_returns where id = p_line_id;
  else
    select dispatch_id, item_code into v_do, v_item from public.dispatch_order_lines where id = p_line_id;
  end if;
  if v_do is null then raise exception 'Item line not found'; end if;
  if exists (select 1 from public.do_paper_receipt_requests where line_id = p_line_id and status = 'Pending') then
    raise exception 'A paper-receipt request is already pending for this item';
  end if;
  select do_number, factory_code into v_no, v_fac from public.dispatch_orders where id = v_do;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.do_paper_receipt_requests (dispatch_id, do_number, factory_code, line_id, line_kind, item_code, reason, requested_by, requested_by_name)
  values (v_do, v_no, v_fac, p_line_id, coalesce(p_kind, 'fg'), v_item, nullif(btrim(p_reason), ''), auth.uid(), v_name);
end $$;
grant execute on function public.request_do_paper_line_receipt(uuid, text, text) to authenticated, anon, service_role;

create or replace function public.approve_do_paper_receipt(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_req public.do_paper_receipt_requests; v_recv text; v_appr text;
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can approve a paper receipt'; end if;
  select * into v_req from public.do_paper_receipt_requests where id = p_id;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'Pending' then raise exception 'This request was already handled'; end if;
  select full_name into v_appr from public.profiles where id = auth.uid();
  v_recv := coalesce(v_req.requested_by_name, v_appr);

  if v_req.line_id is not null then
    if v_req.line_kind = 'return' then
      update public.material_returns
        set received_at = coalesce(received_at, now()), received_by = coalesce(v_req.requested_by, auth.uid()), received_by_name = v_recv
        where id = v_req.line_id and received_at is null;
    else
      update public.dispatch_order_lines
        set received_at = coalesce(received_at, now()), received_by = coalesce(v_req.requested_by, auth.uid()), received_by_name = v_recv
        where id = v_req.line_id and received_at is null;
    end if;
  else
    update public.dispatch_order_lines
      set received_at = coalesce(received_at, now()), received_by = coalesce(v_req.requested_by, auth.uid()), received_by_name = v_recv
      where dispatch_id = v_req.dispatch_id and received_at is null;
    update public.material_returns
      set received_at = coalesce(received_at, now()), received_by = coalesce(v_req.requested_by, auth.uid()), received_by_name = v_recv
      where dispatch_id = v_req.dispatch_id and received_at is null;
  end if;
  perform public._do_receipt_rollup(v_req.dispatch_id, v_recv);

  update public.do_paper_receipt_requests
    set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_appr, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_do_paper_receipt(uuid) to authenticated, anon, service_role;


-- 4) PENDING staging bin ------------------------------------------------------
insert into public.wms_locations (warehouse_code, category, location_type, code, label, active)
select '8BT', 'Stock', 'SL', 'PENDING', 'Pending — awaiting orders', true
where not exists (select 1 from public.wms_locations where warehouse_code = '8BT' and code = 'PENDING');
update public.wms_locations set active = true, pickable = true
  where warehouse_code = '8BT' and code = 'PENDING';


-- 5) SQL GRN number on Purchase Orders ----------------------------------------
alter table public.wms_purchase_orders add column if not exists sql_grn_no text;

create or replace function public.set_po_sql_grn(p_po_id uuid, p_grn text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  update public.wms_purchase_orders set sql_grn_no = nullif(btrim(p_grn), '') where id = p_po_id;
end $$;
grant execute on function public.set_po_sql_grn(uuid, text) to authenticated, anon, service_role;


-- Tell PostgREST to reload the schema so the new columns/functions are live.
notify pgrst, 'reload schema';
