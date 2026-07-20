-- ⚠️ SUPERSEDED — DO NOT RUN THIS FILE. Run db/2026-07-fix-stock-audit-and-reconcile.sql
-- instead. This version's reconciliation logs to `stock_adjustments`, which is actually the
-- stock-adjustment REQUEST table and lacks old_qty/new_qty — so it errors and rolls back
-- (the create_direct_delivery fix below never applies). The corrective file re-does the fix
-- and reconciles against a dedicated item_stock_audit table. Kept only for history.
-- ----------------------------------------------------------------------------
-- Stop "direct delivery" from creating negative item_stock, and clean up the mess it made.
-- ----------------------------------------------------------------------------
-- THE LEAK: create_direct_delivery (Dispatch → deliver straight off a sales line)
-- subtracted the delivered quantity from item_stock AND, when no row existed, inserted
-- a brand-new NEGATIVE row from nothing:
--     update item_stock set quantity = quantity - qty ...;
--     if not found then insert ... values (item, factory, -qty) ...;   -- ← negatives
-- But item_stock is the RAW-MATERIAL / factory on-hand ledger. Finished goods never
-- get ADDED to it (record_production only consumes raw materials and bumps produced_qty;
-- finished-goods on-hand lives in the WMS / wms_stock). So every direct delivery of a
-- finished good pushed item_stock further negative — producing the 100+ negative rows.
--
-- The normal path (create_delivery_order) is the correct model: finished-goods batch
-- lines NEVER touch item_stock, and its raw-material return lines decrement with a plain
-- update…where (no negative-insert fallback), so they can't manufacture a negative either.
--
-- THIS FILE:
--   1. Redefines create_direct_delivery to NOT touch item_stock at all (finished goods
--      belong in the WMS) — a faithful copy of the current body with only that block removed.
--   2. One-time reconciliation: zeroes the negative rows that are PROVABLY finished-goods
--      artifacts (item is produced — a BOM parent or has a production batch — and is NOT
--      itself consumed as an ingredient anywhere), recording every change in the existing
--      stock_adjustments audit table. Semi-finished goods (produced AND consumed) and plain
--      raw materials are LEFT ALONE — those need a physical count, not an auto-fix.
--   3. Adds item_stock_negatives() so Head Office can see what's left to verify by hand
--      (correct each in Packing → Stock, which calls the audited set_item_stock).
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run (step 2 only ever acts on
-- rows that are still negative, so re-running does nothing once they're cleared).
-- Depends on db/2026-07-audit-stamping.sql (stock_adjustments table + set_item_stock).
-- ============================================================================

-- 1) The fix: create_direct_delivery no longer writes item_stock ---------------
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

-- 2) One-time reconciliation of the negatives it already created --------------
-- Only clears rows that are unambiguously finished-goods artifacts. Everything else
-- (raw materials, and semi-finished goods that are both produced and consumed) is left
-- exactly as-is for a human to reconcile against a physical count.
do $$
declare r record; n int := 0; v_left int;
begin
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
    insert into public.stock_adjustments (item_id, factory_code, old_qty, new_qty, set_by, set_by_name)
    values (r.item_id, r.factory_code, r.quantity, 0, null, 'System — WMS reconciliation (finished-goods artifact; on-hand lives in WMS)');
    delete from public.item_stock where item_id = r.item_id and factory_code = r.factory_code;
    n := n + 1;
  end loop;
  select count(*) into v_left from public.item_stock where quantity < 0;
  raise notice 'Reconciliation: cleared % finished-goods negative row(s). % negative row(s) remain for physical verification (see item_stock_negatives()).', n, v_left;
end $$;

-- 3) Report what's left for Head Office to verify by hand ---------------------
-- Read-only. Lists every remaining negative on-hand, flagging whether it looks produced
-- (a semi-finished good to review) or a plain raw material (likely a real count gap).
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
