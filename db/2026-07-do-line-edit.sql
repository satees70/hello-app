-- 2026-07 · Let the delivery-order cart edit finished-goods line details.
-- ============================================================================
-- Adds an optional p_batch_overrides argument to create_delivery_order: a JSON
-- map of batch_id -> { item_code, description, quantity, batch_no, exp_date }.
-- When a batch has an override, that line uses the edited values; otherwise it
-- behaves exactly as before. The batch is still marked dispatched and the
-- batch_id link is kept, so traceability is unchanged.
--
-- This is a NEW 4-argument overload; the old 3-argument version is left in place.
-- SAFE TO RE-RUN. Run in the Supabase SQL editor.
-- ============================================================================

create or replace function public.create_delivery_order(
  p_batch_ids uuid[], p_returns jsonb, p_vehicle text default null, p_batch_overrides jsonb default null
) returns text
language plpgsql security definer set search_path = public as $$
declare v_fac text; v_dig text; v_no text; v_id uuid; v_name text; v_seq int;
        b record; r jsonb; ov jsonb; v_lot public.stock_lots; v_item public.items; v_qty numeric; v_manual boolean;
        v_has_batches boolean; v_has_returns boolean;
begin
  if not has_perm('dispatch', 'edit') then raise exception 'Not allowed to create delivery orders'; end if;
  v_has_batches := p_batch_ids is not null and array_length(p_batch_ids, 1) is not null;
  v_has_returns := p_returns is not null and jsonb_array_length(p_returns) > 0;
  if not v_has_batches and not v_has_returns then raise exception 'Add at least one item to the delivery order'; end if;

  if v_has_batches then select factory_code into v_fac from public.production_batches where id = p_batch_ids[1]; end if;
  if v_fac is null and v_has_returns then
    select factory_code into v_fac from public.stock_lots where id = (p_returns->0->>'lot_id')::uuid;
    if v_fac is null then v_fac := nullif(p_returns->0->>'factory_code', ''); end if;
  end if;
  if v_fac is null then raise exception 'Could not work out the factory for this delivery order'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and not (v_fac = any (my_factory_codes())) then raise exception 'Not allowed for this factory'; end if;
  if my_factory_code() <> 'HEAD_OFFICE' and exists (select 1 from public.profiles where id = auth.uid() and v_fac = any (readonly_factories))
    then raise exception 'You have view-only access at this factory'; end if;
  if v_has_batches and exists (select 1 from public.production_batches where id = any (p_batch_ids) and factory_code <> v_fac)
    then raise exception 'All finished goods must be from the same factory'; end if;

  v_dig := coalesce(nullif(regexp_replace(v_fac, '[^0-9]', '', 'g'), ''), v_fac);
  select count(*) + 1 into v_seq from public.dispatch_orders where factory_code = v_fac and to_char(created_at, 'YYMM') = to_char(now(), 'YYMM');
  v_no := 'DO' || v_dig || '-' || to_char(now(), 'YYMM') || '/' || lpad(v_seq::text, 4, '0');
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.dispatch_orders (do_number, factory_code, created_by, created_by_name, vehicle)
  values (v_no, v_fac, auth.uid(), v_name, nullif(btrim(p_vehicle), '')) returning id into v_id;

  if v_has_batches then
    for b in select * from public.production_batches where id = any (p_batch_ids) and dispatched_at is null loop
      ov := case when p_batch_overrides is not null then p_batch_overrides -> b.id::text else null end;
      insert into public.dispatch_order_lines (dispatch_id, batch_id, item_code, description, quantity, batch_no, exp_date)
      values (
        v_id, b.id,
        coalesce(nullif(ov->>'item_code', ''), b.item_code),
        coalesce(ov->>'description', b.description),
        coalesce((ov->>'quantity')::numeric, b.produced_qty),
        coalesce(nullif(ov->>'batch_no', ''), b.product_batch_no),
        coalesce(nullif(ov->>'exp_date', '')::date, b.exp_date)
      );
      update public.production_batches set dispatched_at = now() where id = b.id;
    end loop;
  end if;

  if v_has_returns then
    for r in select value from jsonb_array_elements(p_returns) as e(value) loop
      v_qty := (r->>'qty')::numeric;
      if v_qty is null or v_qty <= 0 then raise exception 'Return quantity must be greater than zero'; end if;
      v_manual := coalesce((r->>'manual')::boolean, false) or nullif(r->>'lot_id', '') is null;
      if not v_manual then
        select * into v_lot from public.stock_lots where id = (r->>'lot_id')::uuid and factory_code = v_fac;
        if not found then raise exception 'A returned material batch was not found at this factory'; end if;
        if v_qty > v_lot.qty_remaining then raise exception 'Not enough in batch % — only % left', coalesce(v_lot.batch_no, '(no batch)'), v_lot.qty_remaining; end if;
        select * into v_item from public.items where code = v_lot.item_code limit 1;
        update public.stock_lots set qty_remaining = qty_remaining - v_qty where id = v_lot.id;
        if v_item.id is not null then
          update public.item_stock set quantity = quantity - v_qty, updated_at = now() where item_id = v_item.id and factory_code = v_fac;
        end if;
        insert into public.material_returns (factory_code, item_code, description, batch_no, exp_date, quantity, reason, dispatch_id, lot_id, created_by, created_by_name)
        values (v_fac, v_lot.item_code, v_item.description, v_lot.batch_no, v_lot.exp_date, v_qty, nullif(r->>'reason', ''), v_id, v_lot.id, auth.uid(), v_name);
      else
        if nullif(r->>'item_code', '') is null then raise exception 'Manual return needs an item code'; end if;
        if nullif(r->>'batch_no', '') is null and nullif(r->>'exp_date', '') is null then raise exception 'A returned item needs a batch number or an expiry date'; end if;
        select * into v_item from public.items where code = r->>'item_code' limit 1;
        if v_item.id is not null then
          update public.item_stock set quantity = quantity - v_qty, updated_at = now() where item_id = v_item.id and factory_code = v_fac;
        end if;
        insert into public.material_returns (factory_code, item_code, description, batch_no, exp_date, quantity, reason, dispatch_id, lot_id, created_by, created_by_name)
        values (v_fac, r->>'item_code', coalesce(v_item.description, nullif(r->>'description', '')), nullif(r->>'batch_no', ''), nullif(r->>'exp_date','')::date, v_qty, nullif(r->>'reason', ''), v_id, null, auth.uid(), v_name);
      end if;
    end loop;
  end if;

  return v_no;
end $$;
grant execute on function public.create_delivery_order(uuid[], jsonb, text, jsonb) to authenticated;
