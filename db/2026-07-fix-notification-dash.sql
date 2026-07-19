-- Fix the garbled dash in "Lorry out / on the way" notifications.
--
-- The transport notifications used a fancy em-dash "—". When the function was pasted into the
-- Supabase SQL editor the character got corrupted (shown in the app as "‚Äî"), so every lorry
-- notification reads "...has left production ‚Äî on the way...". This re-creates the two functions
-- with a plain hyphen "-" (which can never be mangled) and cleans up the existing notification rows.
--
-- Run in the Supabase SQL editor. Safe to re-run.

-- 1) Production lorry departs → tell the warehouse it's on the way.
create or replace function public.mark_lorry_out(p_do_id uuid, p_out boolean default true) returns void
 language plpgsql security definer set search_path to 'public' as $function$
declare v_fac text; v_no text; v_veh text; v_drv text;
begin
  if not has_perm('dispatch', 'edit') then raise exception 'Not allowed'; end if;
  select factory_code, do_number, vehicle, driver_name into v_fac, v_no, v_veh, v_drv from public.dispatch_orders where id = p_do_id;
  if v_fac is null then raise exception 'Delivery order not found'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_fac = any (my_factory_codes())) then raise exception 'Not your factory'; end if;
  update public.dispatch_orders
     set departed_at = case when p_out then now() else null end,
         departed_by = case when p_out then auth.uid() else null end
   where id = p_do_id;
  if p_out then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (v_fac, 'transport', 'Lorry out: ' || coalesce(v_no, 'DO'),
            'Lorry ' || coalesce(v_veh, '(unassigned)') || coalesce(' · driver ' || v_drv, '') || ' has left production - on the way to the warehouse.',
            '/incoming', 'lorry-out:' || p_do_id::text || ':' || floor(extract(epoch from now()))::text)
    on conflict (ref) do nothing;
  end if;
end; $function$;
grant execute on function public.mark_lorry_out(uuid, boolean) to authenticated;

-- 2) Warehouse lorry departs towards a factory (Goods-Received transport).
create or replace function public.mark_gr_out(p_doc_id uuid, p_out boolean default true) returns void
 language plpgsql security definer set search_path to 'public' as $function$
declare v_fac text; v_no text; v_veh text; v_drv text;
begin
  select factory_code, do_number, vehicle, driver_name into v_fac, v_no, v_veh, v_drv from public.delivery_orders where id = p_doc_id;
  if v_fac is null then raise exception 'Document not found'; end if;
  if not public._gr_warehouse() then raise exception 'Not allowed'; end if;
  update public.delivery_orders set gr_departed_at = case when p_out then now() else null end,
         gr_departed_by = case when p_out then auth.uid() else null end where id = p_doc_id;
  perform public._gr_log(p_doc_id, case when p_out then 'Sent to factory' else 'Send undone' end, coalesce(v_veh, '') || coalesce(' · ' || v_drv, ''));
  if p_out then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (v_fac, 'transport', 'Incoming lorry on the way: ' || coalesce(v_no, ''),
            'Lorry ' || coalesce(v_veh, '') || coalesce(' · driver ' || v_drv, '') || ' has left the warehouse - confirm when it arrives.', '/incoming',
            'gr-out:' || p_doc_id::text || ':' || floor(extract(epoch from now()))::text)
    on conflict (ref) do nothing;
  end if;
end; $function$;
grant execute on function public.mark_gr_out(uuid, boolean) to authenticated;

-- 3) Clean up the notifications already sent. Position-based (byte-agnostic): replace whatever junk
--    sits between the two words with a plain " - ". Leaves the correct "· by <who>" part untouched.
update public.notifications
   set body = regexp_replace(body, 'left production.{1,12}?on the way', 'left production - on the way', 'g')
 where body ~ 'left production' and body ~ 'on the way';

update public.notifications
   set body = regexp_replace(body, 'left the warehouse.{1,12}?confirm when it arrives', 'left the warehouse - confirm when it arrives', 'g')
 where body ~ 'left the warehouse' and body ~ 'confirm when it arrives';

notify pgrst, 'reload schema';
