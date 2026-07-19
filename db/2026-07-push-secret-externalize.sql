-- SECURITY: stop hard-coding the push secret in the committed trigger.
-- ----------------------------------------------------------------------------
-- tg_push_notification() previously embedded the shared push secret in plaintext
-- (db/migrations.sql:2394). Anyone with repo access could read it and forge
-- factory-wide push sends. This rewrites the trigger to read the secret from a
-- database setting (`app.settings.push_secret`) instead, so the live value is
-- NEVER committed. Rotating it then makes the old committed value useless.
--
-- Safe failure mode: if the setting is not present, the trigger simply does not
-- send a push (it never errors) — the in-app notification row is still created,
-- so nothing breaks; phone alerts just pause until the setting is configured.
--
-- ▶ ROTATION STEPS (do in this order — see the chat for the plain-language version):
--   1. Generate a new random secret, e.g.  openssl rand -hex 32
--   2. In THIS SQL editor, set it (paste your new value — do NOT commit it):
--        alter database postgres set app.settings.push_secret = 'YOUR_NEW_SECRET';
--   3. In Vercel, set env  PUSH_SECRET = YOUR_NEW_SECRET  and redeploy production.
--   4. Run this migration (below).
--   5. Test: trigger any notification and confirm the phone push arrives.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create or replace function public.tg_push_notification() returns trigger
 language plpgsql security definer set search_path to 'public, net' as $function$
declare v_secret text := current_setting('app.settings.push_secret', true);
begin
  -- Not configured yet → skip the push (the notification row still exists in-app).
  if v_secret is null or v_secret = '' then
    return NEW;
  end if;
  perform net.http_post(
    url := 'https://production.srrieaswari.com/api/push',
    body := jsonb_build_object('id', NEW.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-push-secret', v_secret)
  );
  return NEW;
end; $function$;

notify pgrst, 'reload schema';
