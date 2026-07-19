-- Supersede a prior "Outstanding Sales Order Listing" when a fresh one is uploaded.
-- ----------------------------------------------------------------------------
-- The listing is a periodic FULL snapshot of what is still outstanding (from SQL
-- Account). Re-uploading used to create a second set of lines that BOTH counted
-- as outstanding (inflating totals), and confirm_document_factory blocked the new
-- one with "Resolve duplicate SO+item lines" until the old document was deleted by
-- hand. This makes the newest listing the source of truth: one action supersedes
-- the prior listing so its lines drop out of every outstanding count and the new
-- one confirms cleanly — without ever duplicating the Order Board or disturbing
-- production that has already started.
--
-- Behaviour (confirmed with the owner):
--   * Planned (not-started) batches from the superseded listing are detached, so
--     confirming the new listing rebuilds them via apply_line_to_production — no
--     duplicate batches.
--   * In-progress / completed batches are NEVER auto-changed — they get a review
--     flag for Head Office to reconcile (quantity may have dropped).
--   * An order that dropped OFF the newest listing gets an 'orphaned' flag for
--     Head Office to confirm-close (it is never auto-cancelled — it may be
--     mid-production).
--
-- Reversible: superseded_at can be cleared to un-supersede. The recreated
-- confirm_document_factory is a faithful copy of the live base-schema function
-- (pasted from Supabase) with ONLY the duplicate-guard/loop taught to ignore
-- superseded lines.
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- ============================================================================

-- 1) Columns -----------------------------------------------------------------
alter table public.sales_imports     add column if not exists superseded_at timestamptz;
alter table public.sales_imports     add column if not exists superseded_by uuid;
alter table public.sales_order_lines  add column if not exists superseded_at timestamptz;
alter table public.production_batches  add column if not exists review_flag text;   -- 'orphaned' | 'superseded_inprogress' | null
alter table public.production_batches  add column if not exists review_note text;

create index if not exists idx_sales_order_lines_superseded on public.sales_order_lines (superseded_at);

-- 2) confirm_document_factory: faithful copy of the live function, taught to
--    ignore SUPERSEDED lines in the duplicate guard and the apply loop so a
--    superseded re-upload no longer blocks confirmation. (Everything else is
--    byte-for-byte the current base-schema body.)
create or replace function public.confirm_document_factory(p_import_id uuid, p_factory text)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare r record; v_name text; v_total int; v_done int;
begin
  if my_factory_code() <> 'HEAD_OFFICE' and p_factory <> all(my_factory_codes()) then
    raise exception 'You can only confirm your own factory''s lines';
  end if;
  if not exists (select 1 from public.sales_order_lines where import_id = p_import_id and factory_code = p_factory and superseded_at is null) then
    raise exception 'No lines for % in this document', p_factory;
  end if;
  if exists (
    select 1 from public.change_requests cr join public.sales_order_lines l on l.id = cr.line_id
    where cr.import_id = p_import_id and cr.status = 'Pending' and l.factory_code = p_factory
  ) then
    raise exception 'Resolve pending change requests for % before confirming', p_factory;
  end if;
  -- duplicate = same SO+item in MORE THAN ONE non-superseded document (re-upload)
  if exists (
    select 1 from public.sales_order_lines l
    where l.import_id = p_import_id and l.factory_code = p_factory and l.superseded_at is null and coalesce(l.so_number,'') <> ''
      and (select count(distinct l2.import_id) from public.sales_order_lines l2
           where l2.so_number = l.so_number and l2.item_code = l.item_code and l2.superseded_at is null) > 1
  ) then
    raise exception 'Resolve duplicate SO+item lines (appears in another document) for % before confirming', p_factory;
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.document_confirmations (import_id, factory_code, confirmed_by, confirmed_by_name)
  values (p_import_id, p_factory, auth.uid(), v_name)
  on conflict (import_id, factory_code) do nothing;

  for r in select id from public.sales_order_lines where import_id = p_import_id and factory_code = p_factory and superseded_at is null loop
    perform public.apply_line_to_production(r.id);
  end loop;

  select count(distinct factory_code) into v_total from public.sales_order_lines
    where import_id = p_import_id and coalesce(factory_code,'') <> '' and superseded_at is null;
  select count(*) into v_done from public.document_confirmations where import_id = p_import_id;
  update public.sales_imports
    set status = case when v_done >= v_total then 'Confirmed' else 'Partially Confirmed' end
    where id = p_import_id;
end; $function$;

-- 3) supersede_prior_listing(new import) --------------------------------------
-- Marks every prior active listing that overlaps the new one as superseded,
-- detaches Planned batches, and flags in-progress / dropped-off batches for HO.
create or replace function public.supersede_prior_listing(p_new_import_id uuid)
  returns integer language plpgsql security definer set search_path = public as $$
declare ol record; v_new_id uuid; v_batch_id uuid; v_batch_status text;
  v_imports uuid[] := '{}'; v_cnt int := 0;
begin
  if not (is_ho_or_admin() or has_perm('sales', 'edit')) then
    raise exception 'Not allowed';
  end if;

  for ol in
    select l.* from public.sales_order_lines l
    where l.superseded_at is null
      and l.import_id <> p_new_import_id
      and exists (
        select 1 from public.sales_order_lines nl
        where nl.import_id = p_new_import_id
          and nl.so_number = l.so_number and nl.item_code = l.item_code
      )
  loop
    -- Still on the new listing (same SO+item+factory)?
    select nl.id into v_new_id from public.sales_order_lines nl
      where nl.import_id = p_new_import_id and nl.so_number = ol.so_number
        and nl.item_code = ol.item_code and coalesce(nl.factory_code,'') = coalesce(ol.factory_code,'')
      limit 1;

    -- The batch this old line feeds.
    select b.id, b.status into v_batch_id, v_batch_status
      from public.production_batch_items i join public.production_batches b on b.id = i.batch_id
      where i.line_id = ol.id limit 1;

    if v_batch_id is not null then
      if v_batch_status = 'Planned' then
        -- not started → detach; the new listing's confirm rebuilds it cleanly
        delete from public.production_batch_items where line_id = ol.id;
      elsif coalesce(v_batch_status,'') <> 'Completed' then
        -- started but not done → never auto-touch; flag for HO
        update public.production_batches
          set review_flag = case when v_new_id is null then 'orphaned' else 'superseded_inprogress' end,
              review_note = case when v_new_id is null
                then 'No longer on the latest listing — close this batch?'
                else 'Re-uploaded listing — check the quantity against production.' end
          where id = v_batch_id;
      end if;
    end if;

    update public.sales_order_lines set superseded_at = now() where id = ol.id;
    v_imports := array_append(v_imports, ol.import_id);
    v_cnt := v_cnt + 1;
  end loop;

  -- Recompute + drop now-empty Planned batches.
  update public.production_batches b
    set total_quantity = coalesce((select sum(quantity) from public.production_batch_items i where i.batch_id = b.id), 0)
    where b.status = 'Planned';
  delete from public.production_batches b
    where b.status = 'Planned' and not exists (select 1 from public.production_batch_items i where i.batch_id = b.id);

  -- Mark the superseded imports.
  update public.sales_imports set superseded_at = now(), superseded_by = p_new_import_id
    where superseded_at is null and id = any(v_imports);

  return v_cnt;
end $$;
grant execute on function public.supersede_prior_listing(uuid) to authenticated;

-- 4) Head-Office actions on a flagged batch ----------------------------------
create or replace function public.close_orphaned_batch(p_batch_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_ho_or_admin() then raise exception 'Only Head Office can close a batch'; end if;
  update public.production_batches set status = 'Cancelled', review_flag = null where id = p_batch_id;
end $$;
grant execute on function public.close_orphaned_batch(uuid) to authenticated;

create or replace function public.clear_batch_flag(p_batch_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_ho_or_admin() then raise exception 'Only Head Office can clear the flag'; end if;
  update public.production_batches set review_flag = null where id = p_batch_id;
end $$;
grant execute on function public.clear_batch_flag(uuid) to authenticated;

notify pgrst, 'reload schema';
