-- Label override with Head Office approval: when a label (printed at the factory) is "not ready"
-- but packing needs to proceed, factory staff can REQUEST to mark it received; HO approves, and on
-- approval the label's required quantity is booked into stock (so it reads "in stock" / ready).
-- This is the controlled alternative to editing the label's stock number directly.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create table if not exists public.label_override_requests (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid,
  item_id uuid not null,
  item_code text,
  factory_code text not null,
  qty numeric not null,
  reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.label_override_requests to authenticated, anon, service_role;
grant update, delete on public.label_override_requests to service_role;
alter table public.label_override_requests enable row level security;
drop policy if exists lor_read on public.label_override_requests;
create policy lor_read on public.label_override_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists lor_insert on public.label_override_requests;
create policy lor_insert on public.label_override_requests for insert with check (requested_by = auth.uid());

-- HO approves: book the label as received into stock (item_stock + an audit lot), so it's ready.
create or replace function public.approve_label_override(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.label_override_requests; v_name text; v_desc text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.label_override_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  if coalesce(r.qty,0) <= 0 then raise exception 'Override quantity must be greater than zero'; end if;
  select description into v_desc from public.items where id = r.item_id;
  insert into public.stock_lots (item_id, item_code, description, factory_code, qty_received, qty_remaining, unplanned)
  values (r.item_id, r.item_code, v_desc, r.factory_code, r.qty, r.qty, true);
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (r.item_id, r.factory_code, r.qty, now())
  on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + r.qty, updated_at = now();
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.label_override_requests
    set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
    where id = p_id;
end $$;
grant execute on function public.approve_label_override(uuid) to authenticated;

create or replace function public.reject_label_override(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.label_override_requests
    set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
    where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_label_override(uuid) to authenticated;

notify pgrst, 'reload schema';
