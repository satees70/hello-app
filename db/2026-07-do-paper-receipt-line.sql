-- Extend "received on paper" requests to a SINGLE item line, not just the whole delivery order.
-- Warehouse staff can now ask Head Office to accept one line on paper; approving confirms just
-- that line (or the whole DO, if the request had no specific line — the original behaviour).
--
-- Run in the Supabase SQL editor. Safe to re-run. Depends on db/2026-07-do-paper-receipt.sql.

alter table public.do_paper_receipt_requests add column if not exists line_id uuid;
alter table public.do_paper_receipt_requests add column if not exists line_kind text;   -- 'fg' | 'return'
alter table public.do_paper_receipt_requests add column if not exists item_code text;

-- Request paper receipt for ONE line. p_kind: 'fg' (finished goods) or 'return' (raw-material return).
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

-- Approve: if the request names a line, confirm just that line; otherwise confirm the whole DO.
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

notify pgrst, 'reload schema';
