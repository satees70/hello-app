-- Warehouse Receiving "received on paper" for EVERYONE, with approval for non-managers.
-- A manager (Head Office / admin) can already confirm a delivery order's items without photos
-- (for old deliveries checked on paper before the system). This lets ANY warehouse user ask to
-- do the same: they raise a request, and a manager (Head Office) approves it — approval confirms
-- every still-unreceived line + return on that DO on paper (no photos) and marks the DO received.
--
-- Run in the Supabase SQL editor. Safe to re-run. Depends on the DO receipt functions
-- (db/2026-07-do-line-receipt.sql + db/2026-07-do-return-receipt.sql: _do_receipt_rollup).

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

-- Warehouse staff (and Head Office/admin) can see the queue; a requester always sees their own.
drop policy if exists dopr_read on public.do_paper_receipt_requests;
create policy dopr_read on public.do_paper_receipt_requests for select using (
  coalesce((select warehouse_user from public.profiles where id = auth.uid()), false)
  or public.is_ho_or_admin() or requested_by = auth.uid()
);
drop policy if exists dopr_insert on public.do_paper_receipt_requests;
create policy dopr_insert on public.do_paper_receipt_requests for insert with check (requested_by = auth.uid());

-- Raise a request: any warehouse user (or a manager). One open request per DO.
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

-- Approve (Head Office): confirm every still-unreceived line + return on the DO without photos,
-- crediting the person who received it (the requester), then roll the DO up to received.
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

  update public.dispatch_order_lines
    set received_at = coalesce(received_at, now()), received_by = coalesce(v_req.requested_by, auth.uid()), received_by_name = v_recv
    where dispatch_id = v_req.dispatch_id and received_at is null;
  update public.material_returns
    set received_at = coalesce(received_at, now()), received_by = coalesce(v_req.requested_by, auth.uid()), received_by_name = v_recv
    where dispatch_id = v_req.dispatch_id and received_at is null;
  perform public._do_receipt_rollup(v_req.dispatch_id, v_recv);

  update public.do_paper_receipt_requests
    set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_appr, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_do_paper_receipt(uuid) to authenticated, anon, service_role;

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

notify pgrst, 'reload schema';
