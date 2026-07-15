-- One Cancel Note number per SALES ORDER: when several items of the same SO are cancelled (in one
-- go or over time), they all share the SO's Cancel Note number instead of each getting its own.
-- The first cancel of an SO mints the number; every later item of that SO reuses it.
--
-- Depends on db/2026-07-cancel-note-number.sql. Run in the Supabase SQL editor. Safe to re-run.

create or replace function public.approve_so_balance_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.so_balance_cancel_requests; l public.sales_order_lines; v_name text; b record; v_cancel numeric; v_no text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.so_balance_cancel_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  -- reuse this SO's existing Cancel Note number, or mint a new one
  select cancel_note_no into v_no from public.so_balance_cancel_requests
    where so_number = r.so_number and cancel_note_no is not null order by created_at limit 1;
  if v_no is null then v_no := 'CN-' || lpad(nextval('public.cancel_note_seq')::text, 5, '0'); end if;
  select * into l from public.sales_order_lines where id = r.so_line_id;
  if found then
    v_cancel := greatest(0, coalesce(l.outstanding_qty, l.quantity, 0) - coalesce(l.delivered_qty, 0));
    update public.sales_order_lines
      set balance_cancelled_qty = v_cancel, balance_cancelled_at = now(), balance_cancelled_by = auth.uid(),
          balance_cancel_reason = r.reason, balance_cancel_no = v_no, outstanding_qty = coalesce(delivered_qty, 0)
      where id = l.id;
    for b in
      select pb.id, pb.material_request_id from public.production_batches pb
      where pb.item_code = r.item_code and pb.factory_code = r.factory_code
        and coalesce(pb.produced_qty,0) = 0 and coalesce(pb.status,'') not in ('Completed','Cancelled')
        and exists (select 1 from public.production_batch_items x where x.batch_id = pb.id and x.so_number = r.so_number)
        and not exists (select 1 from public.production_batch_items x where x.batch_id = pb.id and coalesce(x.so_number,'') <> coalesce(r.so_number,''))
    loop
      if b.material_request_id is not null
         and (select count(*) from public.production_batches where material_request_id = b.material_request_id) = 1
         and not exists (select 1 from public.material_request_items mi where mi.request_id = b.material_request_id and coalesce(mi.received_qty,0) > 0) then
        delete from public.material_request_items where request_id = b.material_request_id;
        delete from public.material_requests where id = b.material_request_id;
      end if;
      update public.production_batches set status = 'Cancelled', material_request_id = null where id = b.id;
    end loop;
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.so_balance_cancel_requests
    set status = 'Approved', cancel_note_no = v_no, reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
    where id = p_id;
end $$;
grant execute on function public.approve_so_balance_cancel(uuid) to authenticated;

create or replace function public.cancel_so_balance_now(p_line_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare l public.sales_order_lines; v_bal numeric; v_name text; b record; v_no text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can cancel directly'; end if;
  select * into l from public.sales_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  v_bal := greatest(0, coalesce(l.outstanding_qty, l.quantity, 0) - coalesce(l.delivered_qty, 0));
  if v_bal <= 0 then raise exception 'This line has no outstanding balance to cancel'; end if;
  select cancel_note_no into v_no from public.so_balance_cancel_requests
    where so_number = l.so_number and cancel_note_no is not null order by created_at limit 1;
  if v_no is null then v_no := 'CN-' || lpad(nextval('public.cancel_note_seq')::text, 5, '0'); end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  update public.sales_order_lines
    set balance_cancelled_qty = v_bal, balance_cancelled_at = now(), balance_cancelled_by = auth.uid(),
        balance_cancel_reason = nullif(p_reason,''), balance_cancel_no = v_no, outstanding_qty = coalesce(delivered_qty, 0)
    where id = l.id;

  for b in
    select pb.id, pb.material_request_id from public.production_batches pb
    where pb.item_code = l.item_code and pb.factory_code = l.factory_code
      and coalesce(pb.produced_qty,0) = 0 and coalesce(pb.status,'') not in ('Completed','Cancelled')
      and exists (select 1 from public.production_batch_items x where x.batch_id = pb.id and x.so_number = l.so_number)
      and not exists (select 1 from public.production_batch_items x where x.batch_id = pb.id and coalesce(x.so_number,'') <> coalesce(l.so_number,''))
  loop
    if b.material_request_id is not null
       and (select count(*) from public.production_batches where material_request_id = b.material_request_id) = 1
       and not exists (select 1 from public.material_request_items mi where mi.request_id = b.material_request_id and coalesce(mi.received_qty,0) > 0) then
      delete from public.material_request_items where request_id = b.material_request_id;
      delete from public.material_requests where id = b.material_request_id;
    end if;
    update public.production_batches set status = 'Cancelled', material_request_id = null where id = b.id;
  end loop;

  insert into public.so_balance_cancel_requests
    (so_line_id, so_number, customer_name, item_code, description, factory_code, ordered_qty, delivered_qty, cancel_qty,
     reason, status, cancel_note_no, requested_by, requested_by_name, reviewed_by, reviewed_by_name, reviewed_at)
  values (l.id, l.so_number, l.customer_name, l.item_code, l.description, l.factory_code,
     coalesce(l.outstanding_qty, l.quantity, 0), coalesce(l.delivered_qty, 0), v_bal,
     nullif(p_reason,''), 'Approved', v_no, auth.uid(), v_name, auth.uid(), v_name, now());
end $$;
grant execute on function public.cancel_so_balance_now(uuid, text) to authenticated;

notify pgrst, 'reload schema';
