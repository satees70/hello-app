-- Two warehouse write-safety fixes: expired-lot auto-assignment, and uncapped damage decrement.
-- ----------------------------------------------------------------------------
-- (1) wms_auto_repick_on_receipt (the PENDING-lock version) was branched from a pre-expiry copy
--     and lost the guard that keeps EXPIRED lots out of auto-assignment. It was floating expired
--     stock from GOODS-IN into PENDING and even reserving it to customer orders. Re-add the
--     `exp_date is null or exp_date >= current_date` guard to BOTH the GOODS-IN float and the
--     PENDING reservation loops, so expired stock is never auto-assigned to an order.
--
-- (2) wms_report_damage decremented the source bin by the reported qty with no cap, and inserted
--     a negative row from nothing when the bin had no matching row — creating a phantom-negative
--     bin. Cap the move at what's actually on hand (like every other mover), so damage quarantine
--     stays balanced and never manufactures a negative. If the bin shows nothing of that item,
--     it's rejected (nothing there to quarantine — the bin/batch is wrong, or stock needs a count).
--
-- Run in the Supabase SQL editor. Idempotent / safe to re-run.
-- Depends on db/2026-07-wms-pending-lock.sql and db/2026-07-wms-damage.sql.
-- ============================================================================

-- (1) Keep expired lots out of auto-assignment --------------------------------------------
create or replace function public.wms_auto_repick_on_receipt() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pending uuid; v_goodsin uuid;
  v_need numeric; v_rem numeric; v_move numeric;
  v_line_need numeric; v_free numeric; v_alloc numeric; v_reopened numeric;
  r record; ol record; ps record;
begin
  if NEW.move_type <> 'receipt' or NEW.item_code is null then return NEW; end if;
  select coalesce(sum(no_stock_qty), 0) into v_need from public.wms_order_lines
    where item_code = NEW.item_code and no_stock = true and coalesce(no_stock_qty, 0) > 0;
  if v_need <= 0 then return NEW; end if;

  select id into v_pending from public.wms_locations where warehouse_code = '8BT' and code = 'PENDING';
  select id into v_goodsin from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
  if v_pending is null or v_goodsin is null then return NEW; end if;

  -- (1) Float the just-arrived stock from GOODS-IN into the pickable PENDING bin, up to the
  --     total still outstanding — skipping EXPIRED lots (never auto-assign an expired lot).
  v_rem := v_need;
  for r in select * from public.wms_stock
           where warehouse_code = '8BT' and item_code = NEW.item_code and location_id = v_goodsin and quantity > 0
             and (exp_date is null or exp_date >= current_date)
           order by exp_date nulls last, updated_at loop
    exit when v_rem <= 0;
    v_move := least(r.quantity, v_rem);
    update public.wms_stock set quantity = quantity - v_move, updated_at = now() where id = r.id;
    delete from public.wms_stock where id = r.id and quantity <= 0;
    insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values ('8BT', r.item_id, r.item_code, r.description, v_pending, 'PENDING', r.batch_no, r.exp_date, v_move, r.uom)
    on conflict (warehouse_code, item_code, location_id, batch_no)
      do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      from_location_id, from_location_code, to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values ('8BT', 'transfer', r.item_id, r.item_code, r.description, v_goodsin, 'GOODS-IN', v_pending, 'PENDING', r.batch_no, r.exp_date, v_move,
      'Auto → PENDING (stock arrived for outstanding order)', NEW.moved_by, NEW.moved_by_name);
    v_rem := v_rem - v_move;
  end loop;

  -- (2) Hand PENDING stock to the waiting orders OLDEST-FIRST, LOCKING each order's share with an
  --     active reservation — again skipping EXPIRED batches so none is reserved to a customer.
  for ol in select ol.id as line_id, ol.order_id, ol.item_id, ol.item_code, ol.no_stock_qty,
                   o.order_no, o.assigned_to
            from public.wms_order_lines ol join public.wms_orders o on o.id = ol.order_id
            where ol.item_code = NEW.item_code and ol.no_stock = true and coalesce(ol.no_stock_qty, 0) > 0
            order by o.created_at asc nulls last, ol.no_stock_at asc nulls last loop
    v_line_need := ol.no_stock_qty;
    for ps in select s.batch_no, s.exp_date, s.quantity from public.wms_stock s
              where s.warehouse_code = '8BT' and s.item_code = ol.item_code and s.location_id = v_pending and s.quantity > 0
                and (s.exp_date is null or s.exp_date >= current_date)
              order by s.exp_date nulls last, s.updated_at loop
      exit when v_line_need <= 0;
      v_free := ps.quantity - coalesce((select sum(qty) from public.wms_reservations
                 where status = 'active' and item_code = ol.item_code and location_id = v_pending and batch_no = ps.batch_no), 0);
      if v_free <= 0 then continue; end if;
      v_alloc := least(v_free, v_line_need);
      insert into public.wms_reservations (order_id, order_line_id, item_id, item_code, location_id, location_code, batch_no, exp_date, qty, created_by, created_by_name)
      values (ol.order_id, ol.line_id, ol.item_id, ol.item_code, v_pending, 'PENDING', ps.batch_no, ps.exp_date, v_alloc, NEW.moved_by, NEW.moved_by_name);
      v_line_need := v_line_need - v_alloc;
    end loop;

    v_reopened := ol.no_stock_qty - v_line_need;   -- how much we actually locked for this order
    if v_reopened > 0 then
      update public.wms_order_lines
        set quantity          = coalesce(qty_picked, 0) + v_reopened,
            no_stock          = case when v_line_need > 0 then true else false end,
            no_stock_qty      = case when v_line_need > 0 then v_line_need else null end,
            no_stock_by       = case when v_line_need > 0 then no_stock_by else null end,
            no_stock_by_name  = case when v_line_need > 0 then no_stock_by_name else null end,
            no_stock_at       = case when v_line_need > 0 then no_stock_at else null end,
            no_stock_note     = case when v_line_need > 0 then no_stock_note else null end
        where id = ol.line_id;
      update public.wms_orders set status = 'Picking'
        where id = ol.order_id and status in ('Picked', 'Checked', 'Partially Dispatched', 'Dispatched');
      insert into public.notifications (factory_code, type, title, body, link, ref)
        values ('HEAD_OFFICE', 'wms', '📦 Stock arrived — reserved & ready to pick',
          'Order ' || coalesce(ol.order_no, '') || ' — ' || v_reopened::text || ' of ' || ol.item_code || ' reserved and ready to pick.',
          '/wms/orders', 'autopick:' || ol.line_id::text || ':' || NEW.id::text)
        on conflict (ref) do nothing;
      if ol.assigned_to is not null then
        insert into public.notifications (factory_code, user_id, type, title, body, link, ref)
          values ('8BT', ol.assigned_to, 'wms', '📦 Stock arrived — ready to pick',
            'Order ' || coalesce(ol.order_no, '') || ' — ' || ol.item_code || ' reserved for you, please pick.',
            '/wms/pick/' || ol.order_id::text, 'autopick_p:' || ol.line_id::text || ':' || NEW.id::text)
          on conflict (ref) do nothing;
      end if;
    end if;
  end loop;
  return NEW;
exception when others then
  return NEW;   -- never block a receipt on a repick hiccup (unchanged safety net)
end $$;

-- (2) Damage quarantine capped at on-hand (no phantom-negative source bin) -----------------
create or replace function public.wms_report_damage(p_line_id uuid, p_location_id uuid, p_batch text, p_qty numeric, p_note text default null)
  returns uuid language plpgsql security definer set search_path = public as $$
declare v_line public.wms_order_lines; v_order public.wms_orders; v_name text; v_src text; v_dmg uuid;
  v_batch text := coalesce(nullif(btrim(p_batch), ''), ''); v_avail numeric; v_take numeric; v_id uuid;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to move warehouse stock'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Damaged quantity must be greater than zero'; end if;
  if p_location_id is null then raise exception 'Choose the bin the damaged stock is in'; end if;
  select * into v_line from public.wms_order_lines where id = p_line_id;
  if not found then raise exception 'Order line not found'; end if;
  select * into v_order from public.wms_orders where id = v_line.order_id;
  select code into v_src from public.wms_locations where id = p_location_id;
  if v_src is null then raise exception 'Bin not found'; end if;
  select id into v_dmg from public.wms_locations where warehouse_code = '8BT' and code = 'DAMAGED';
  if v_dmg is null then raise exception 'DAMAGED location missing — run db/2026-07-wms-damage.sql'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  -- Quarantine only what the bin actually holds — never drive the source bin negative.
  select coalesce(quantity, 0) into v_avail from public.wms_stock
    where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = p_location_id and batch_no = v_batch;
  if coalesce(v_avail, 0) <= 0 then
    raise exception 'That bin shows no % to quarantine — check the bin/batch (or count the stock first).', v_line.item_code;
  end if;
  v_take := least(v_avail, p_qty);

  update public.wms_stock set quantity = quantity - v_take, updated_at = now()
    where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = p_location_id and batch_no = v_batch;
  delete from public.wms_stock where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = p_location_id and batch_no = v_batch and quantity <= 0;
  -- hold it in DAMAGED (same qty in as out — balanced)
  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, quantity, uom)
  values ('8BT', v_line.item_id, v_line.item_code, v_line.description, v_dmg, 'DAMAGED', v_batch, v_take, v_line.uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, updated_at = now();
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    from_location_id, from_location_code, to_location_id, to_location_code, batch_no, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'transfer', v_line.item_id, v_line.item_code, v_line.description,
    p_location_id, v_src, v_dmg, 'DAMAGED', v_batch, v_take,
    'Damaged — quarantined for HO review' || case when nullif(btrim(p_note), '') is not null then ' · ' || btrim(p_note) else '' end, auth.uid(), v_name);

  -- Report records the quantity actually quarantined, so a later write-off stays balanced.
  insert into public.wms_damage_reports (order_id, order_no, line_id, item_id, item_code, description, uom, from_location_id, from_location_code, batch, qty, note, reported_by, reported_by_name)
  values (v_line.order_id, v_order.order_no, p_line_id, v_line.item_id, v_line.item_code, v_line.description, v_line.uom, p_location_id, v_src, v_batch, v_take, nullif(btrim(p_note), ''), auth.uid(), v_name)
  returning id into v_id;

  insert into public.notifications (factory_code, type, title, body, link, ref)
  values ('HEAD_OFFICE', 'wms', '🐛 Damaged stock — review',
    coalesce(v_line.item_code, '') || ' × ' || v_take::text || ' from ' || v_src || case when v_batch <> '' then ' · b:' || v_batch else '' end
      || ' quarantined by ' || coalesce(v_name, '?') || case when nullif(btrim(p_note), '') is not null then ' · ' || btrim(p_note) else '' end,
    '/wms/approvals', 'damage:' || v_id::text)
  on conflict (ref) do nothing;
  return v_id;
end $$;
grant execute on function public.wms_report_damage(uuid, uuid, text, numeric, text) to authenticated;

notify pgrst, 'reload schema';
