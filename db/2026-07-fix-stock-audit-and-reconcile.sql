-- Corrective: fix the stock-audit table clash, then re-run the direct-delivery fix + reconcile.
-- ----------------------------------------------------------------------------
-- WHAT WENT WRONG: db/2026-07-audit-stamping.sql assumed `stock_adjustments` was a fresh
-- audit table. It is NOT — it already exists (db/migrations.sql) as the stock-adjustment
-- REQUEST / approval workflow (direction in/out, quantity>0, status, approve_stock_adjustment).
-- So in that migration:
--   • `create table if not exists stock_adjustments (...)` was a no-op → the old_qty/new_qty
--     columns were never added;
--   • `set_item_stock` was left inserting into columns that don't exist → it throws at runtime
--     ("column old_qty does not exist") whenever someone edits on-hand in Packing → Stock;
--   • its `sa_read` RLS policy clobbered the request table's own policy;
--   • and db/2026-07-fix-direct-delivery-fg-stock.sql's reconciliation hit the same error
--     (its whole transaction rolled back, so the create_direct_delivery leak fix did NOT apply
--     either — this file re-applies it).
--
-- THIS FILE fixes all of it, in the right place:
--   (A) restore the stock-adjustment REQUEST table's original RLS;
--   (B) give absolute on-hand corrections their OWN audit table, item_stock_audit;
--   (C) set_item_stock — working + audited (supersedes both earlier versions);
--   (D) re-apply the create_direct_delivery leak fix (no longer touches item_stock);
--   (E) reconcile the finished-goods negative rows, logging to item_stock_audit;
--   (F) item_stock_negatives() report.
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run. Supersedes the stock parts of
-- db/2026-07-audit-stamping.sql and all of db/2026-07-fix-direct-delivery-fg-stock.sql.
-- ============================================================================

-- (A) Restore the stock-adjustment REQUEST table's own RLS (undo the earlier clobber) -------
drop policy if exists sa_read on public.stock_adjustments;
create policy sa_read on public.stock_adjustments for select
  using (my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes()) or requested_by = auth.uid());
drop policy if exists sa_insert on public.stock_adjustments;
create policy sa_insert on public.stock_adjustments for insert with check (requested_by = auth.uid());

-- (B) Dedicated audit trail for absolute on-hand corrections --------------------------------
create table if not exists public.item_stock_audit (
  id uuid primary key default gen_random_uuid(),
  item_id uuid, item_code text, factory_code text,
  old_qty numeric, new_qty numeric, reason text,
  set_by uuid, set_by_name text, created_at timestamptz not null default now()
);
alter table public.item_stock_audit enable row level security;
drop policy if exists isa_read on public.item_stock_audit;
create policy isa_read on public.item_stock_audit for select to authenticated
  using (public.is_ho_or_admin() or public.has_perm('packing','view') or factory_code = any (public.my_factory_codes()));
grant select on public.item_stock_audit to authenticated;   -- writes only via the SECURITY DEFINER functions below

-- (C) set_item_stock — absolute set (negative allowed), now recording old→new -------------
create or replace function public.set_item_stock(p_item_id uuid, p_factory text, p_qty numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_old numeric;
begin
  if not has_perm('packing','edit') then raise exception 'Not allowed to edit stock'; end if;
  if p_item_id is null or coalesce(p_factory,'') = '' then raise exception 'Item and factory are required'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (p_factory = any (my_factory_codes())) then
    raise exception 'Not allowed for this factory'; end if;
  if p_qty is null then raise exception 'Enter a stock quantity'; end if;
  select quantity into v_old from public.item_stock where item_id = p_item_id and factory_code = p_factory;
  -- Absolute set (not add), negative allowed on purpose.
  insert into public.item_stock (item_id, factory_code, quantity, updated_at)
  values (p_item_id, p_factory, p_qty, now())
  on conflict (item_id, factory_code) do update set quantity = excluded.quantity, updated_at = now();
  insert into public.item_stock_audit (item_id, factory_code, old_qty, new_qty, reason, set_by, set_by_name)
  values (p_item_id, p_factory, v_old, p_qty, 'Manual stock set', auth.uid(), (select full_name from public.profiles where id = auth.uid()));
end $$;
grant execute on function public.set_item_stock(uuid, text, numeric) to authenticated, anon, service_role;

-- (D) The leak fix: create_direct_delivery no longer writes item_stock ---------------------
create or replace function public.create_direct_delivery(p_lines jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare v_fac text; v_dig text; v_no text; v_id uuid; v_name text; v_seq int;
        r jsonb; v_line public.sales_order_lines; v_qty numeric;
begin
  if not has_perm('dispatch', 'edit') then raise exception 'Not allowed to create delivery orders'; end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one item'; end if;
  select * into v_line from public.sales_order_lines where id = (p_lines->0->>'line_id')::uuid;
  if not found then raise exception 'Sales order line not found'; end if;
  v_fac := v_line.factory_code;
  if nullif(v_fac, '') is null then raise exception 'This sales line has no factory/location set — set it first'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_fac = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;

  v_dig := coalesce(nullif(regexp_replace(v_fac, '[^0-9]', '', 'g'), ''), v_fac);
  select count(*) + 1 into v_seq from public.dispatch_orders where factory_code = v_fac and to_char(created_at, 'YYMM') = to_char(now(), 'YYMM');
  v_no := 'DO' || v_dig || '-' || to_char(now(), 'YYMM') || '/' || lpad(v_seq::text, 4, '0');
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.dispatch_orders (do_number, factory_code, created_by, created_by_name)
  values (v_no, v_fac, auth.uid(), v_name) returning id into v_id;

  for r in select value from jsonb_array_elements(p_lines) as e(value) loop
    select * into v_line from public.sales_order_lines where id = (r->>'line_id')::uuid;
    if not found then continue; end if;
    if v_line.factory_code <> v_fac then raise exception 'All items must be from the same factory'; end if;
    v_qty := (r->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
    insert into public.dispatch_order_lines (dispatch_id, batch_id, item_code, description, quantity, source, batch_no, exp_date)
    values (v_id, null, v_line.item_code, v_line.description, v_qty, 'sales-direct', nullif(r->>'batch_no', ''), nullif(r->>'exp_date', '')::date);
    -- NOTE: intentionally does NOT touch item_stock. Finished goods on-hand lives in the
    -- WMS (wms_stock); item_stock is the raw-material ledger and must not go negative here.
    update public.sales_order_lines set delivered_qty = coalesce(delivered_qty, 0) + v_qty, delivered_do = v_no, delivered_at = now() where id = v_line.id;
  end loop;

  return v_no;
end $$;
grant execute on function public.create_direct_delivery(jsonb) to authenticated;

-- (E) One-time reconciliation of the negatives the leak already created --------------------
-- Only clears rows that are unambiguously finished-goods artifacts (produced — a BOM parent
-- or has a production batch — and NOT itself consumed as an ingredient anywhere). Raw
-- materials and semi-finished goods (produced AND consumed) are left for a physical count.
do $$
declare r record; n int := 0; v_left int; v_actor text;
begin
  select full_name into v_actor from public.profiles where id = auth.uid();
  for r in
    select s.item_id, s.factory_code, s.quantity, i.code, i.description
    from public.item_stock s
    join public.items i on i.id = s.item_id
    where s.quantity < 0
      and (
        exists (select 1 from public.bom_components b where b.parent_item_id = s.item_id)   -- has a recipe → produced
        or exists (select 1 from public.production_batches pb where pb.item_code = i.code)   -- has been produced
      )
      and not exists (select 1 from public.bom_components b where b.component_item_id = s.item_id)  -- NOT an ingredient anywhere
  loop
    insert into public.item_stock_audit (item_id, item_code, factory_code, old_qty, new_qty, reason, set_by, set_by_name)
    values (r.item_id, r.code, r.factory_code, r.quantity, 0,
            'WMS reconciliation — finished-goods artifact (on-hand lives in WMS)', auth.uid(), coalesce(v_actor, 'System'));
    delete from public.item_stock where item_id = r.item_id and factory_code = r.factory_code;
    n := n + 1;
  end loop;
  select count(*) into v_left from public.item_stock where quantity < 0;
  raise notice 'Reconciliation: cleared % finished-goods negative row(s). % negative row(s) remain for physical verification (see item_stock_negatives()).', n, v_left;
end $$;

-- (F) Report what's left for Head Office to verify by hand ---------------------------------
create or replace function public.item_stock_negatives()
returns table (item_id uuid, item_code text, description text, factory_code text, quantity numeric, looks_produced boolean)
language sql stable security definer set search_path = public as $$
  select s.item_id, i.code, i.description, s.factory_code, s.quantity,
         (exists (select 1 from public.bom_components b where b.parent_item_id = s.item_id)
          or exists (select 1 from public.production_batches pb where pb.item_code = i.code)) as looks_produced
  from public.item_stock s
  join public.items i on i.id = s.item_id
  where s.quantity < 0
    and (public.is_ho_or_admin()
         or s.factory_code = any (public.my_factory_codes())
         or public.my_factory_code() = 'HEAD_OFFICE')
  order by s.quantity asc;
$$;
grant execute on function public.item_stock_negatives() to authenticated;

notify pgrst, 'reload schema';
