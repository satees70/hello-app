-- 2026-07 · Richer push notifications — show the LOCATION and WHO did it.
-- ============================================================================
-- Before: "New order SO-41293" / "A sales order for your location was added."
-- After:  "New order SO-41293 — Kajang (AVINA102)" / "Uploaded by Ahmad."
--         "Partially Received: DO-260613 — Klang (AVINA101)" / "Received by Siti."
--
-- The phone push uses each notification row's title/body verbatim (see
-- app/api/push/route.ts), so enriching the trigger text is all that's needed.
-- SAFE TO RE-RUN. Run in the Supabase SQL editor.
-- ============================================================================

-- Friendly location label: "Kajang (AVINA102)" when the factory has a name,
-- otherwise just the code. SECURITY DEFINER so it reads `factories` past RLS.
create or replace function public.factory_label(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select case
    when coalesce(p_code, '') = '' then '—'
    else coalesce(
      (select case
                when nullif(btrim(f.name), '') is not null then f.name || ' (' || p_code || ')'
                else p_code
              end
         from public.factories f where f.code = p_code),
      p_code)
  end
$$;
grant execute on function public.factory_label(text) to authenticated, anon, service_role;

-- New sales order → include location + who uploaded it.
-- (Sales lines are inserted by the extraction service, so the uploader comes
--  from sales_imports.uploaded_by, not auth.uid().)
create or replace function public.tg_notify_sales_line() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
declare v_by text;
begin
  if coalesce(NEW.factory_code, '') <> '' then
    select p.full_name into v_by
      from public.sales_imports si
      left join public.profiles p on p.id = si.uploaded_by
     where si.id = NEW.import_id;
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (NEW.factory_code, 'order',
            'New order ' || coalesce(NEW.so_number, '') || ' — ' || public.factory_label(NEW.factory_code),
            coalesce('Uploaded by ' || v_by || '.', 'A sales order was added.'),
            '/sales-orders',
            'neworder:' || NEW.import_id::text || ':' || NEW.factory_code)
    on conflict (ref) do nothing;
  end if;
  return NEW;
end; $function$;

-- Goods received against a delivery order → location + who received it.
-- (Receiving runs under the signed-in user, so auth.uid() is the receiver.)
create or replace function public.tg_notify_grn() returns trigger
 language plpgsql security definer set search_path to 'public' as $function$
declare v_by text;
begin
  if NEW.status is distinct from OLD.status and NEW.status in ('Received', 'Partially Received') then
    select full_name into v_by from public.profiles where id = auth.uid();
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (NEW.factory_code, 'grn',
            NEW.status || ': ' || coalesce(NEW.do_number, NEW.file_name) || ' — ' || public.factory_label(NEW.factory_code),
            'A delivery order was ' || lower(NEW.status) || coalesce(' by ' || v_by, '') || '.',
            '/incoming',
            'grn:' || NEW.id::text || ':' || NEW.status)
    on conflict (ref) do nothing;
  end if;
  return NEW;
end; $function$;
