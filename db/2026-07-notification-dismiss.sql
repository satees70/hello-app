-- 2026-07 · Let each user clear (dismiss) individual notifications.
-- ============================================================================
-- Notifications are shared rows (a whole factory / Head Office sees the same
-- one), so we can't delete a row to clear it for one person. Instead each user
-- keeps their own list of dismissed notification ids; the bell hides those.
-- SAFE TO RE-RUN. Run in the Supabase SQL editor.
-- ============================================================================

create table if not exists public.notification_dismissals (
  user_id         uuid not null,
  notification_id uuid not null,
  dismissed_at    timestamptz not null default now(),
  primary key (user_id, notification_id)
);
grant select, insert, delete on public.notification_dismissals to authenticated;
alter table public.notification_dismissals enable row level security;
drop policy if exists nd_own on public.notification_dismissals;
create policy nd_own on public.notification_dismissals for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Dismiss one notification for the current user (idempotent).
create or replace function public.dismiss_notification(p_id uuid) returns void
 language sql security definer set search_path = public as $$
  insert into public.notification_dismissals (user_id, notification_id)
  values (auth.uid(), p_id)
  on conflict do nothing
$$;
grant execute on function public.dismiss_notification(uuid) to authenticated;
