-- Push secret v2: read from a locked config table (Supabase blocks ALTER DATABASE SET,
-- so the earlier `app.settings.push_secret` GUC approach can't be set from the SQL editor).
-- ----------------------------------------------------------------------------
-- Stores the shared push secret in public.app_secrets, which is RLS-locked and has all
-- grants revoked from anon/authenticated — so no browser/API client can read it. Only
-- SECURITY DEFINER functions (owned by the DB owner) can, which is exactly what the push
-- trigger is. The secret value itself is NEVER committed — you insert it by hand (below).
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- ============================================================================

create table if not exists public.app_secrets (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);
alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from anon, authenticated;
-- (no RLS policy is created on purpose → no client can read/write; the definer trigger can.)

create or replace function public.tg_push_notification() returns trigger
 language plpgsql security definer set search_path to 'public, net' as $function$
declare v_secret text;
begin
  select value into v_secret from public.app_secrets where key = 'push_secret';
  -- Not configured yet → skip the push (the in-app notification row still exists).
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

-- ▶ AFTER running the above, set the secret (paste YOUR value — do NOT commit it), and set
--   the SAME value in Vercel's PUSH_SECRET env, then redeploy:
--   insert into public.app_secrets (key, value) values ('push_secret', 'YOUR_NEW_SECRET')
--     on conflict (key) do update set value = excluded.value, updated_at = now();

notify pgrst, 'reload schema';
