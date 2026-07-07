-- 2026-07 · Add location + who-did-it to EVERY push notification (one place).
-- ============================================================================
-- Rather than edit ~25 separate notification functions (many of which also move
-- stock/transport and are risky to touch), a single BEFORE INSERT trigger on the
-- notifications table enriches every notification as it is created:
--   • appends the location  "— Klang (AVINA15)"  to the title (if not already shown)
--   • appends the person     "· by HAFIZ."        to the body (when a signed-in
--     user caused it and the body doesn't already name them)
--   • drops the now-redundant vague phrase "for your location"
--
-- Works for material requests, pick runs, urgent flags, confirmations, dispatch,
-- transport/lorry, driver, discussion, goods-received, new orders — everything.
-- The already-detailed New Order / Goods Received messages are left as they are
-- (the trigger detects their location/name are present and skips).
--
-- SAFE TO RE-RUN. Run in the Supabase SQL editor.
-- ============================================================================

-- Friendly location label: "Kajang (AVINA102)" if the factory has a name, else
-- the code. (Included here so this file is self-contained; harmless to re-run.)
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

create or replace function public.tg_enrich_notification() returns trigger
 language plpgsql security definer set search_path = public as $function$
declare v_by text; v_loc text; t text; b text;
begin
  t := coalesce(NEW.title, '');
  b := coalesce(NEW.body, '');

  -- Location → title (skip if the code or full label is already in the title).
  if coalesce(NEW.factory_code, '') <> '' then
    v_loc := public.factory_label(NEW.factory_code);
    if v_loc is not null
       and position(NEW.factory_code in t) = 0
       and position(v_loc in t) = 0 then
      t := t || ' — ' || v_loc;
    end if;
  end if;

  -- Tidy the vague phrase now that the location is explicit.
  b := replace(b, ' for your location', '');

  -- Who did it → body (only when a signed-in user caused this insert and the
  -- body doesn't already name them; service-role inserts have no auth.uid()).
  if auth.uid() is not null then
    select full_name into v_by from public.profiles where id = auth.uid();
    if v_by is not null and v_by <> '' and position(v_by in b) = 0 then
      if btrim(b) = '' then b := 'By ' || v_by || '.';
      else b := rtrim(b, ' .') || ' · by ' || v_by || '.';
      end if;
    end if;
  end if;

  NEW.title := t;
  NEW.body := b;
  return NEW;
end; $function$;

drop trigger if exists enrich_notification on public.notifications;
create trigger enrich_notification before insert on public.notifications
  for each row execute function public.tg_enrich_notification();
