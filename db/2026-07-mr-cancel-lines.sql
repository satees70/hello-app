-- Cancel INDIVIDUAL lines of a released material request (e.g. a finished-good code added to a
-- raw-material request by mistake) — needs Head Office approval, like the whole-request cancel.
-- The rest of the request is untouched and keeps being picked/received as normal. If every line
-- ends up cancelled, the whole request is removed and its batch(es) freed (same as a full cancel).
--
-- Run in the Supabase SQL editor. Safe to re-run.

create table if not exists public.mr_cancel_item_requests (
  id uuid primary key default gen_random_uuid(),
  material_request_id uuid,
  request_no text,
  factory_code text,
  item_ids uuid[] not null,        -- the material_request_items to cancel
  item_codes text,                 -- human summary for the approval screen, e.g. "G4226, G4264"
  reason text,
  status text not null default 'Pending',
  requested_by uuid, requested_by_name text,
  reviewed_by uuid, reviewed_by_name text, reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert on public.mr_cancel_item_requests to authenticated, anon, service_role;
grant update, delete on public.mr_cancel_item_requests to service_role;
alter table public.mr_cancel_item_requests enable row level security;
drop policy if exists mrci_read on public.mr_cancel_item_requests;
create policy mrci_read on public.mr_cancel_item_requests for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists mrci_insert on public.mr_cancel_item_requests;
create policy mrci_insert on public.mr_cancel_item_requests for insert with check (requested_by = auth.uid());

-- HO approves: remove the selected (not-yet-received) lines, then recompute the request's status.
-- If nothing is left, cancel the whole request and free its batch(es).
create or replace function public.approve_mr_cancel_items(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.mr_cancel_item_requests; v_name text; v_req uuid;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.mr_cancel_item_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  v_req := r.material_request_id;

  -- A line that already has material received cannot be silently dropped.
  if exists (select 1 from public.material_request_items
             where id = any(r.item_ids) and coalesce(received_qty, 0) > 0) then
    raise exception 'One of those lines has already been received — it cannot be cancelled';
  end if;
  delete from public.material_request_items
    where id = any(r.item_ids) and coalesce(received_qty, 0) = 0;

  if v_req is not null and not exists (select 1 from public.material_request_items where request_id = v_req) then
    -- no lines left: free every batch (only if production has not started) and drop the request
    update public.production_batches set material_request_id = null, status = 'Planned'
      where material_request_id = v_req and coalesce(produced_qty, 0) = 0;
    delete from public.material_requests where id = v_req;
  elsif v_req is not null then
    perform public.recompute_mr_status(v_req);
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  update public.mr_cancel_item_requests
    set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
    where id = p_id;
end $$;
grant execute on function public.approve_mr_cancel_items(uuid) to authenticated;

create or replace function public.reject_mr_cancel_items(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can reject'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.mr_cancel_item_requests
    set status = 'Rejected', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
    where id = p_id and status = 'Pending';
end $$;
grant execute on function public.reject_mr_cancel_items(uuid) to authenticated;

notify pgrst, 'reload schema';
