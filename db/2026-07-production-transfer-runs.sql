-- Pick for Production, v2: work off RELEASED PICK RUNS (combined picking), not raw
-- individual requests. The warehouse only picks once a run has a PR number.
--
-- The warehouse picks a whole run's POOLED materials (same material summed across the
-- run's requests); the transferred quantity is split back across the original request
-- lines oldest-first — exactly like receive_combined_lot. Bags still leave WMS and the
-- equal quantity is booked into factory stock in one step.
--
-- Run in the Supabase SQL editor. Safe to re-run. (Requires the first migration,
-- db/2026-07-production-transfer.sql, to have been run.)

alter table public.wms_production_transfers add column if not exists pick_run text;

-- Replace the per-request function with the run-level one (different args → drop first).
drop function if exists public.wms_transfer_to_production(uuid, jsonb);

-- p_materials = [{
--   item_id, item_code, description,
--   request_item_ids: [uuid, ...],           -- pooled MR lines for this material, oldest-first
--   picks: [{ source_item_code, location_id, batch_no, exp_date, bags, uom, kg_per_bag, kg, override_note }]
-- }]
create or replace function public.wms_transfer_to_production(p_pick_run text, p_factory text, p_materials jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_name text; v_no text; v_tid uuid; mat jsonb; pk jsonb; ri_el jsonb;
  v_src wms_stock; v_bags numeric; v_kg numeric; v_srccode text; v_loc uuid; v_batch text;
  v_itemid uuid; v_itemcode text; v_desc text; v_kgpb numeric; v_uom text; v_ovr text;
  v_mat_qty numeric; v_left numeric; v_need numeric; v_add numeric; v_ri uuid;
  v_all_ri uuid[] := '{}'; v_mats int := 0;
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed to transfer to production'; end if;
  select full_name into v_name from profiles where id = auth.uid();
  v_no := 'PT-' || to_char(now(),'YYMM') || '/' || lpad(nextval('wms_transfer_seq')::text, 4, '0');
  insert into public.wms_production_transfers (transfer_no, pick_run, factory_code, created_by, created_by_name)
    values (v_no, p_pick_run, p_factory, auth.uid(), v_name) returning id into v_tid;

  for mat in select jsonb_array_elements(p_materials) loop
    v_itemid   := nullif(mat->>'item_id','')::uuid;
    v_itemcode := mat->>'item_code';
    v_desc     := mat->>'description';
    v_mat_qty  := 0;

    -- Take each picked bag out of WMS and book the equal quantity into factory stock.
    for pk in select jsonb_array_elements(mat->'picks') loop
      v_srccode := coalesce(pk->>'source_item_code', v_itemcode);
      v_loc     := nullif(pk->>'location_id','')::uuid;
      v_batch   := coalesce(pk->>'batch_no','');
      v_bags    := (pk->>'bags')::numeric;
      v_kg      := (pk->>'kg')::numeric;
      v_kgpb    := nullif(pk->>'kg_per_bag','')::numeric;
      v_uom     := pk->>'uom';
      v_ovr     := nullif(pk->>'override_note','');
      if v_bags is null or v_bags <= 0 or v_kg is null or v_kg <= 0 then continue; end if;

      select * into v_src from wms_stock where item_code = v_srccode and location_id = v_loc and batch_no = v_batch order by warehouse_code limit 1;
      if not found then raise exception 'No warehouse stock of % in that bin/batch', v_srccode; end if;
      if v_src.quantity < v_bags then raise exception 'Only % % of % left in that bin', v_src.quantity, coalesce(v_src.uom,'unit'), v_srccode; end if;

      update wms_stock set quantity = quantity - v_bags, updated_at = now() where id = v_src.id;
      delete from wms_stock where id = v_src.id and quantity <= 0;

      insert into wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
      values (v_src.warehouse_code, 'transfer', v_src.item_id, v_srccode, coalesce(v_desc, v_src.description), v_src.location_id, v_src.location_code, v_batch, v_src.exp_date, v_bags,
        v_no || ' → production' || case when v_ovr is not null then ' (override: ' || v_ovr || ')' else '' end, auth.uid(), v_name);

      insert into stock_lots (item_id, item_code, description, factory_code, batch_no, exp_date, qty_received, qty_remaining, request_item_id, do_number)
      values (v_itemid, v_itemcode, coalesce(v_desc, v_src.description), p_factory, nullif(v_batch,''), v_src.exp_date, v_kg, v_kg, null, v_no);

      insert into item_stock (item_id, factory_code, quantity, updated_at)
      values (v_itemid, p_factory, v_kg, now())
      on conflict (item_id, factory_code) do update set quantity = item_stock.quantity + v_kg, updated_at = now();

      insert into public.wms_production_transfer_lines (transfer_id, request_item_id, item_id, item_code, description, source_item_code, location_id, location_code, batch_no, exp_date, bags, uom, kg_per_bag, kg, override_note)
      values (v_tid, null, v_itemid, v_itemcode, coalesce(v_desc, v_src.description), v_srccode, v_loc, v_src.location_code, nullif(v_batch,''), v_src.exp_date, v_bags, v_uom, v_kgpb, v_kg, v_ovr);

      v_mat_qty := v_mat_qty + v_kg;
    end loop;

    -- Split the material's total across its pooled request lines, oldest-first.
    -- Surplus (over-delivery) stays in factory stock, not forced onto the last line.
    v_left := v_mat_qty;
    for ri_el in select jsonb_array_elements(mat->'request_item_ids') loop
      v_ri := (ri_el #>> '{}')::uuid;
      v_all_ri := array_append(v_all_ri, v_ri);
      if v_left > 0 then
        select greatest(requested_qty - coalesce(received_qty,0), 0) into v_need from material_request_items where id = v_ri;
        if v_need is not null and v_need > 0 then
          v_add := least(v_need, v_left);
          update material_request_items set received_qty = coalesce(received_qty,0) + v_add where id = v_ri;
          v_left := v_left - v_add;
        end if;
      end if;
    end loop;

    v_mats := v_mats + 1;
  end loop;

  -- Recompute the status of every request touched (same rule as goods-received).
  update material_requests m set status = case
      when (select bool_and(coalesce(received_qty,0) >= requested_qty) from material_request_items where request_id = m.id) then 'Fulfilled'
      when (select bool_or(coalesce(received_qty,0) > 0) from material_request_items where request_id = m.id) then 'Partially Received'
      else 'Open' end
    where m.id in (select request_id from material_request_items where id = any(v_all_ri));

  insert into public.notifications (factory_code, type, title, body, link, ref)
  values (p_factory, 'info', 'Materials transferred from warehouse',
    coalesce(v_name,'Warehouse') || ' sent ' || v_mats || ' material(s) to production — ' || v_no
      || case when p_pick_run is not null then ' (run ' || p_pick_run || ')' else '' end,
    '/production', 'pt:' || v_tid::text)
  on conflict (ref) do nothing;

  return jsonb_build_object('transfer_no', v_no, 'materials', v_mats);
end $$;
grant execute on function public.wms_transfer_to_production(text, text, jsonb) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
