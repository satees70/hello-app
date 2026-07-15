-- Cancel the leftover (undelivered) BALANCE of a sales order line — e.g. the order was
-- delivered short and the rest won't be supplied. Factory staff request it; Head Office approves.
-- On approval it (a) closes the line's balance (sets outstanding to what was delivered, so it
-- stops showing as deliverable / pending), (b) conservatively cancels any NOT-yet-started
-- production batch + its material request that exists ONLY for this order, and (c) the request
-- row itself is the permanent "Cancel Note" record.
--
-- Run in the Supabase SQL editor. Safe to re-run.

alter table public.sales_order_lines add column if not exists balance_cancelled_qty numeric;
alter table public.sales_order_lines add column if not exists balance_cancelled_at timestamptz;
alter table public.sales_order_lines add column if not exists balance_cancelled_by uuid;
alter table public.sales_order_lines add column if not exists balance_cancel_reason text;

create table if not exists public.so_balance_cancel_requests (
  id uuid primary key default gen_random_uuid(),
  so_line_id uuid,
  so_number text, customer_name text, item_code text, description text, factory_code text,
  ordered_qty numeric, delivered_qty numeric, cancel_qty numeric,   -- snapshot at request time
  reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.so_balance_cancel_requests to authenticated, anon, service_role;
grant update, delete on public.so_balance_cancel_requests to service_role;
alter table public.so_balance_cancel_requests enable row level security;
drop policy if exists sbc_read on public.so_balance_cancel_requests;
create policy sbc_read on public.so_balance_cancel_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists sbc_insert on public.so_balance_cancel_requests;
create policy sbc_insert on public.so_balance_cancel_requests for insert with check (requested_by = auth.uid());

-- Factory requests the cancel (computes the current balance = (outstanding ?? ordered) − delivered).
create or replace function public.request_so_balance_cancel(p_line_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare l public.sales_order_lines; v_bal numeric; v_name text;
begin
  select * into l from public.sales_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  if not (is_ho_or_admin() or has_perm('sales','edit')) then raise exception 'Not allowed'; end if;
  if l.factory_code is not null and my_factory_code() <> 'HEAD_OFFICE' and not (l.factory_code = any (my_factory_codes())) then
    raise exception 'Not allowed for this factory'; end if;
  v_bal := greatest(0, coalesce(l.outstanding_qty, l.quantity, 0) - coalesce(l.delivered_qty, 0));
  if v_bal <= 0 then raise exception 'This line has no outstanding balance to cancel'; end if;
  if exists (select 1 from public.so_balance_cancel_requests where so_line_id = p_line_id and status = 'Pending') then
    raise exception 'A balance cancel is already pending for this line'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.so_balance_cancel_requests
    (so_line_id, so_number, customer_name, item_code, description, factory_code, ordered_qty, delivered_qty, cancel_qty, reason, requested_by, requested_by_name)
  values (p_line_id, l.so_number, l.customer_name, l.item_code, l.description, l.factory_code,
    coalesce(l.outstanding_qty, l.quantity, 0), coalesce(l.delivered_qty, 0), v_bal, nullif(p_reason,''), auth.uid(), v_name);
end $$;
grant execute on function public.request_so_balance_cancel(uuid, text) to authenticated, anon, service_role;

-- HO approves: close the balance + conservatively free not-started, single-order production.
create or replace function public.approve_so_balance_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r public.so_balance_cancel_requests; l public.sales_order_lines; v_name text; b record; v_cancel numeric;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.so_balance_cancel_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  select * into l from public.sales_order_lines where id = r.so_line_id;
  if found then
    v_cancel := greatest(0, coalesce(l.outstanding_qty, l.quantity, 0) - coalesce(l.delivered_qty, 0));
    update public.sales_order_lines
      set balance_cancelled_qty = v_cancel, balance_cancelled_at = now(), balance_cancelled_by = auth.uid(),
          balance_cancel_reason = r.reason, outstanding_qty = coalesce(delivered_qty, 0)
      where id = l.id;
    -- Cancel only NOT-started production batches that serve THIS order alone (by so_number),
    -- and free their material request only if it is used solely by that batch with nothing received.
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
    set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
    where id = p_id;
end $$;
grant execute on function public.approve_so_balance_cancel(uuid) to authenticated;

create or replace function public.reject_so_balance_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.so_balance_cancel_requests
    set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
    where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_so_balance_cancel(uuid) to authenticated;

notify pgrst, 'reload schema';
