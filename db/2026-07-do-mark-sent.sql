-- Lorry Internal Transfer: let staff mark a delivery order as "Sent" so it drops off the active
-- transport list (a plain declutter marker — it does NOT notify the warehouse or touch the
-- lorry-out / received timestamps, so old orders can be cleared without firing stale alerts).
--
-- Run in the Supabase SQL editor. Safe to re-run.

alter table public.dispatch_orders add column if not exists sent_at timestamptz;
alter table public.dispatch_orders add column if not exists sent_by uuid;
alter table public.dispatch_orders add column if not exists sent_by_name text;

create or replace function public.mark_do_sent(p_do_id uuid, p_sent boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_fac text; v_name text;
begin
  select factory_code into v_fac from public.dispatch_orders where id = p_do_id;
  if v_fac is null then raise exception 'Delivery order not found'; end if;
  if not has_perm('dispatch','view') then raise exception 'Not allowed'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_fac = any (my_factory_codes())) then
    raise exception 'Not allowed for this factory'; end if;
  if p_sent then
    select full_name into v_name from public.profiles where id = auth.uid();
    update public.dispatch_orders set sent_at = now(), sent_by = auth.uid(), sent_by_name = v_name where id = p_do_id;
  else
    update public.dispatch_orders set sent_at = null, sent_by = null, sent_by_name = null where id = p_do_id;
  end if;
end $$;
grant execute on function public.mark_do_sent(uuid, boolean) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
