-- Cancel Notes helper: list outstanding sales-order lines that are NOT on any delivery schedule
-- (candidates to cancel), and let Head Office cancel one straight away (a direct cancel that also
-- writes the Cancel Note record). Factory staff still go through request_so_balance_cancel.
--
-- Depends on db/2026-07-so-balance-cancel.sql. Run in the Supabase SQL editor. Safe to re-run.

-- Candidates: a line with an outstanding balance, not already cancelled, whose SO is not placed on
-- any delivery line. Scoped to the caller's factories (HO sees all).
create or replace function public.so_lines_unscheduled()
returns table (line_id uuid, so_number text, customer_name text, item_code text, description text,
               factory_code text, ordered_qty numeric, delivered_qty numeric, balance numeric)
language sql security definer set search_path = public as $$
  select sol.id, sol.so_number, sol.customer_name, sol.item_code, sol.description, sol.factory_code,
         coalesce(sol.outstanding_qty, sol.quantity, 0),
         coalesce(sol.delivered_qty, 0),
         greatest(0, coalesce(sol.outstanding_qty, sol.quantity, 0) - coalesce(sol.delivered_qty, 0))
  from public.sales_order_lines sol
  where greatest(0, coalesce(sol.outstanding_qty, sol.quantity, 0) - coalesce(sol.delivered_qty, 0)) > 0
    and sol.balance_cancelled_at is null
    and not exists (select 1 from public.delivery_schedule ds where ds.so_number = sol.so_number and ds.route is not null)
    and (my_factory_code() = 'HEAD_OFFICE' or sol.factory_code = any (my_factory_codes()) or sol.factory_code is null)
  order by sol.so_number, sol.item_code;
$$;
grant execute on function public.so_lines_unscheduled() to authenticated, anon, service_role;

-- Head Office cancels a line's balance in one step (close balance + free not-started production +
-- write the Cancel Note as Approved). Same effect as request + approve, for the Cancel Notes tab.
create or replace function public.cancel_so_balance_now(p_line_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare l public.sales_order_lines; v_bal numeric; v_name text; b record;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can cancel directly'; end if;
  select * into l from public.sales_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  v_bal := greatest(0, coalesce(l.outstanding_qty, l.quantity, 0) - coalesce(l.delivered_qty, 0));
  if v_bal <= 0 then raise exception 'This line has no outstanding balance to cancel'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  update public.sales_order_lines
    set balance_cancelled_qty = v_bal, balance_cancelled_at = now(), balance_cancelled_by = auth.uid(),
        balance_cancel_reason = nullif(p_reason,''), outstanding_qty = coalesce(delivered_qty, 0)
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
     reason, status, requested_by, requested_by_name, reviewed_by, reviewed_by_name, reviewed_at)
  values (l.id, l.so_number, l.customer_name, l.item_code, l.description, l.factory_code,
     coalesce(l.outstanding_qty, l.quantity, 0), coalesce(l.delivered_qty, 0), v_bal,
     nullif(p_reason,''), 'Approved', auth.uid(), v_name, auth.uid(), v_name, now());
end $$;
grant execute on function public.cancel_so_balance_now(uuid, text) to authenticated;

notify pgrst, 'reload schema';
