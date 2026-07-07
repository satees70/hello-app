-- 2026-07 · New lorries / crew added by factory users need Head Office approval.
-- ============================================================================
-- Lorries and crew are added by typing a name on the Delivery Schedule "Manage"
-- panel. This gates that: a factory user's new entry is saved as UNAPPROVED and
-- hidden from the assign-lorry / assign-driver dropdowns until Head Office
-- approves it. Head Office (and admins) add entries directly (auto-approved).
--
-- Enforced in the database (a BEFORE INSERT trigger sets `approved`), so the
-- client can't self-approve by sending approved=true.
--
-- SAFE TO RE-RUN. Run in the Supabase SQL editor.
-- ============================================================================

-- Existing rows stay usable (default true); new inserts are set by the trigger.
alter table public.delivery_resources add column if not exists approved boolean not null default true;

-- Is the current caller Head Office or an admin?
create or replace function public.is_ho_or_admin() returns boolean
 language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
      or coalesce(public.my_factory_code() = 'HEAD_OFFICE', false)
$$;
grant execute on function public.is_ho_or_admin() to authenticated, anon, service_role;

-- New entry → approved only if HO/admin added it; otherwise pending + notify HO.
create or replace function public.tg_delivery_resource_approval() returns trigger
 language plpgsql security definer set search_path = public as $function$
declare v_name text;
begin
  NEW.approved := public.is_ho_or_admin();
  if not NEW.approved then
    select full_name into v_name from public.profiles where id = auth.uid();
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values ('HEAD_OFFICE', 'resource',
            'Approve ' || (case when NEW.kind = 'lorry' then 'lorry' else 'crew' end) || ': ' || NEW.name,
            coalesce('Added by ' || v_name || '.', 'A new entry was added.') || ' Needs Head Office approval.',
            '/delivery-schedule',
            'res-approve:' || NEW.id::text)
    on conflict (ref) do nothing;
  end if;
  return NEW;
end; $function$;
drop trigger if exists delivery_resource_approval on public.delivery_resources;
create trigger delivery_resource_approval before insert on public.delivery_resources
  for each row execute function public.tg_delivery_resource_approval();

-- Head Office approves a pending entry.
create or replace function public.approve_delivery_resource(p_id uuid) returns void
 language plpgsql security definer set search_path = public as $function$
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can approve'; end if;
  update public.delivery_resources set approved = true where id = p_id;
end; $function$;
grant execute on function public.approve_delivery_resource(uuid) to authenticated;

-- Head Office rejects (removes) a still-pending entry.
create or replace function public.reject_delivery_resource(p_id uuid) returns void
 language plpgsql security definer set search_path = public as $function$
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can reject'; end if;
  delete from public.delivery_resources where id = p_id and approved = false;
end; $function$;
grant execute on function public.reject_delivery_resource(uuid) to authenticated;
