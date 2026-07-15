-- Record sales-order items that were ALREADY SENT to the customer outside the system (no DO was
-- ever created). Like a direct delivery it marks the sales line delivered (a bypass), but it does
-- NOT create a dispatch_orders / DO number and does NOT touch stock (the goods already left) — so
-- it stays out of "Recent delivery orders" and shows in its own list.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create table if not exists public.prior_deliveries (
  id uuid primary key default gen_random_uuid(),
  so_line_id uuid,
  so_number text, customer_name text, item_code text, description text,
  factory_code text, quantity numeric, batch_no text, exp_date date, note text,
  created_by uuid, created_by_name text,
  created_at timestamptz not null default now()
);
grant select, insert on public.prior_deliveries to authenticated, anon, service_role;
grant update, delete on public.prior_deliveries to service_role;
alter table public.prior_deliveries enable row level security;
drop policy if exists prior_read on public.prior_deliveries;
create policy prior_read on public.prior_deliveries for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or factory_code is null);

create or replace function public.record_prior_delivery(p_lines jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare r jsonb; v_line public.sales_order_lines; v_name text; v_qty numeric; v_n int := 0;
begin
  if not has_perm('dispatch','edit') then raise exception 'Not allowed'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  for r in select jsonb_array_elements(p_lines) loop
    select * into v_line from public.sales_order_lines where id = nullif(r->>'line_id','')::uuid;
    if not found then continue; end if;
    if v_line.factory_code is not null and my_factory_code() <> 'HEAD_OFFICE' and not (v_line.factory_code = any (my_factory_codes())) then
      raise exception 'Not allowed for this factory'; end if;
    v_qty := (r->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then continue; end if;
    insert into public.prior_deliveries (so_line_id, so_number, customer_name, item_code, description,
      factory_code, quantity, batch_no, exp_date, note, created_by, created_by_name)
    values (v_line.id, v_line.so_number, v_line.customer_name, v_line.item_code, v_line.description,
      v_line.factory_code, v_qty, nullif(r->>'batch_no',''), nullif(r->>'exp_date','')::date, nullif(r->>'note',''),
      auth.uid(), v_name);
    -- mark the sales line delivered (bypass); keep any real DO number, else tag as PREV. Stock untouched.
    update public.sales_order_lines
      set delivered_qty = coalesce(delivered_qty,0) + v_qty, delivered_at = now(),
          delivered_do = coalesce(delivered_do, 'PREV')
      where id = v_line.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
grant execute on function public.record_prior_delivery(jsonb) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
