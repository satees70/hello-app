-- 2026-07 · Make "Pick run cancel" approval tolerate an already-gone request.
-- ============================================================================
-- WHY: approve_mr_cancel() approves a request to cancel a material request by
-- calling cancel_material_request(), which raises "Request not found" if that
-- material request no longer exists. When the underlying request was already
-- removed by another path, the pending cancel-request becomes an orphan that can
-- never be approved (Approve always errors; only Reject clears it).
--
-- FIX: if the underlying material request is already gone, the cancellation is
-- effectively already done — mark the request Approved instead of erroring
-- (idempotent). If it still exists, behaviour is unchanged, including the guard
-- that blocks cancelling a request that has already received material.
--
-- SAFE TO RE-RUN. Run in the Supabase SQL editor.
-- ============================================================================

create or replace function public.approve_mr_cancel(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.mr_cancel_requests; v_name text; v_exists boolean;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.mr_cancel_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;

  -- Only cancel the underlying request if it still exists. If it's already gone
  -- (cancelled/deleted elsewhere), skip straight to marking this Approved so the
  -- orphan can't dead-end on "Request not found".
  select exists (select 1 from public.material_requests where id = r.material_request_id) into v_exists;
  if v_exists then
    perform public.cancel_material_request(r.material_request_id);  -- frees batches, deletes request (raises if already received)
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  update public.mr_cancel_requests
     set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now()
   where id = p_id;
end $$;
