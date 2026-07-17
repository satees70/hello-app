-- Receiving books stock into the warehouse + auto-pick when stock arrives for a short order,
-- plus a one-time backfill of production goods received on/after 15 July 2026.
--
-- PART A — Warehouse Receiving now enters stock. Confirming a production / raw-material-return
-- delivery line books that quantity into GOODS-IN (a 'receipt' move), the same way a supplier PO
-- receipt does. A `wms_booked_at` marker makes it book exactly once (idempotent).
-- PART B — Auto-pick. On a 'receipt' move for an item an order is waiting on (picker confirmed
-- "no stock"): move the needed qty GOODS-IN → PENDING, re-open those orders, notify picker + HO.
-- PART C — One-time backfill: book every production/return line received on/after 2026-07-15 that
-- wasn't booked yet (so past receipts enter stock and flow through the same auto-pick).
-- Run in the Supabase SQL editor. Safe to re-run (the marker prevents double-booking).

-- ============================ PART A · receiving books stock ============================
alter table public.dispatch_order_lines add column if not exists batch_no text;
alter table public.dispatch_order_lines add column if not exists exp_date date;
alter table public.dispatch_order_lines add column if not exists received_at timestamptz;
alter table public.dispatch_order_lines add column if not exists received_by uuid;
alter table public.dispatch_order_lines add column if not exists received_by_name text;
alter table public.dispatch_order_lines add column if not exists photo_path text;
alter table public.dispatch_order_lines add column if not exists wms_booked_at timestamptz;   -- set once the goods are in WMS stock

create or replace function public.confirm_do_line(p_line_id uuid, p_photo_path text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_do uuid; v_pending int; v_line public.dispatch_order_lines;
  v_item_id uuid; v_desc text; v_uom text; v_stage uuid; v_dono text; v_grn text; v_batch text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can confirm a delivery line';
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  select * into v_line from public.dispatch_order_lines where id = p_line_id;
  if not found then raise exception 'Delivery line not found'; end if;
  v_do := v_line.dispatch_id;
  update public.dispatch_order_lines
     set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name,
         photo_path = coalesce(nullif(p_photo_path, ''), photo_path)
   where id = p_line_id;

  -- Book the goods into warehouse stock (GOODS-IN) — exactly once (marker-guarded).
  if v_line.wms_booked_at is null and coalesce(v_line.quantity, 0) > 0 and nullif(btrim(v_line.item_code), '') is not null then
    v_batch := coalesce(v_line.batch_no, '');
    select id, description, unit into v_item_id, v_desc, v_uom from public.items where code = v_line.item_code;
    select id into v_stage from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
    select do_number, warehouse_grn into v_dono, v_grn from public.dispatch_orders where id = v_do;
    if v_stage is not null then
      insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
      values ('8BT', v_item_id, v_line.item_code, coalesce(v_line.description, v_desc), v_stage, 'GOODS-IN', v_batch, v_line.exp_date, v_line.quantity, v_uom)
      on conflict (warehouse_code, item_code, location_id, batch_no)
        do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
      insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
        to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
      values ('8BT', 'receipt', v_item_id, v_line.item_code, coalesce(v_line.description, v_desc), v_stage, 'GOODS-IN', v_batch, v_line.exp_date, v_line.quantity,
        'DO ' || coalesce(v_dono, '') || case when nullif(v_grn, '') is not null then ' · GRN ' || v_grn else '' end, auth.uid(), v_name);
      update public.dispatch_order_lines set wms_booked_at = now() where id = p_line_id;
    end if;
  end if;

  select count(*) into v_pending from public.dispatch_order_lines where dispatch_id = v_do and received_at is null;
  if v_pending = 0 then
    update public.dispatch_orders set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name where id = v_do;
    insert into public.notifications (author_id, factory_code, type, title, body, link, ref)
    select auth.uid(), d.factory_code, 'dispatch', '📦 Delivery received at warehouse',
           'Delivery order ' || coalesce(d.do_number, '') || ' fully received'
             || case when nullif(d.warehouse_grn, '') is not null then ' · GRN ' || d.warehouse_grn else '' end
             || ' by ' || coalesce(v_name, 'warehouse') || '.',
           '/dispatch', 'do_received:' || d.id::text
      from public.dispatch_orders d where d.id = v_do
      on conflict (ref) do nothing;
  end if;
end $$;
grant execute on function public.confirm_do_line(uuid, text) to authenticated;

create or replace function public.unconfirm_do_line(p_line_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_do uuid; v_line public.dispatch_order_lines; v_stage uuid; v_have numeric; v_take numeric; v_batch text; v_name text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can change a delivery line';
  end if;
  select * into v_line from public.dispatch_order_lines where id = p_line_id;
  if not found then raise exception 'Delivery line not found'; end if;
  v_do := v_line.dispatch_id;
  if v_line.wms_booked_at is not null and coalesce(v_line.quantity, 0) > 0 and nullif(btrim(v_line.item_code), '') is not null then
    v_batch := coalesce(v_line.batch_no, '');
    select full_name into v_name from public.profiles where id = auth.uid();
    select id into v_stage from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
    select quantity into v_have from public.wms_stock where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = v_stage and batch_no = v_batch;
    if v_stage is not null and coalesce(v_have, 0) > 0 then
      v_take := least(v_have, v_line.quantity);
      update public.wms_stock set quantity = quantity - v_take, updated_at = now() where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = v_stage and batch_no = v_batch;
      delete from public.wms_stock where warehouse_code = '8BT' and item_code = v_line.item_code and location_id = v_stage and batch_no = v_batch and quantity <= 0;
      insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description, from_location_id, from_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
      values ('8BT', 'adjust', (select id from public.items where code = v_line.item_code), v_line.item_code, v_line.description, v_stage, 'GOODS-IN', v_batch, v_line.exp_date, v_take, 'Undo receiving', auth.uid(), v_name);
    end if;
    update public.dispatch_order_lines set wms_booked_at = null where id = p_line_id;
  end if;
  update public.dispatch_order_lines set received_at = null, received_by = null, received_by_name = null where id = p_line_id;
  update public.dispatch_orders set received_at = null where id = v_do;
end $$;
grant execute on function public.unconfirm_do_line(uuid) to authenticated;

-- ============================ PART B · auto-pick on receipt ============================
create or replace function public.wms_auto_repick_on_receipt() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_need numeric; v_pending uuid; v_goodsin uuid; v_move numeric; v_rem numeric; r record;
begin
  if NEW.move_type <> 'receipt' or NEW.item_code is null then return NEW; end if;
  select coalesce(sum(no_stock_qty), 0) into v_need from public.wms_order_lines
    where item_code = NEW.item_code and no_stock = true and coalesce(no_stock_qty, 0) > 0;
  if v_need <= 0 then return NEW; end if;
  select id into v_pending from public.wms_locations where warehouse_code = '8BT' and code = 'PENDING';
  select id into v_goodsin from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
  if v_pending is not null and v_goodsin is not null then
    v_rem := v_need;
    for r in select * from public.wms_stock
             where warehouse_code = '8BT' and item_code = NEW.item_code and location_id = v_goodsin and quantity > 0
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
  end if;
  for r in select ol.id, ol.order_id, ol.item_code, ol.no_stock_qty, o.order_no, o.assigned_to
           from public.wms_order_lines ol join public.wms_orders o on o.id = ol.order_id
           where ol.item_code = NEW.item_code and ol.no_stock = true and coalesce(ol.no_stock_qty, 0) > 0 loop
    update public.wms_order_lines
      set quantity = coalesce(qty_picked, 0) + no_stock_qty,
          no_stock = false, no_stock_qty = null, no_stock_by = null, no_stock_by_name = null, no_stock_at = null, no_stock_note = null
      where id = r.id;
    update public.wms_orders set status = 'Picking'
      where id = r.order_id and status in ('Picked', 'Checked', 'Partially Dispatched', 'Dispatched');
    insert into public.notifications (factory_code, type, title, body, link, ref)
      values ('HEAD_OFFICE', 'wms', '📦 Stock arrived — ready to pick',
        'Order ' || coalesce(r.order_no, '') || ' can now pick ' || r.item_code || ' (' || coalesce(r.no_stock_qty, 0)::text || ' outstanding).',
        '/wms/orders', 'autopick:' || r.id::text || ':' || NEW.id::text)
      on conflict (ref) do nothing;
    if r.assigned_to is not null then
      insert into public.notifications (factory_code, user_id, type, title, body, link, ref)
        values ('8BT', r.assigned_to, 'wms', '📦 Stock arrived — ready to pick',
          'Order ' || coalesce(r.order_no, '') || ' — ' || r.item_code || ' arrived, please pick.',
          '/wms/pick/' || r.order_id::text, 'autopick_p:' || r.id::text || ':' || NEW.id::text)
        on conflict (ref) do nothing;
    end if;
  end loop;
  return NEW;
exception when others then
  return NEW;
end $$;

drop trigger if exists trg_wms_auto_repick on public.wms_stock_moves;
create trigger trg_wms_auto_repick after insert on public.wms_stock_moves
  for each row when (NEW.move_type = 'receipt') execute function public.wms_auto_repick_on_receipt();

-- ============================ PART C · one-time backfill (received on/after 2026-07-15) ============================
do $$
declare r record; v_stage uuid; v_item_id uuid; v_desc text; v_uom text; v_batch text;
begin
  select id into v_stage from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
  if v_stage is null then return; end if;
  for r in
    select dl.*, d.do_number, d.warehouse_grn
    from public.dispatch_order_lines dl
    join public.dispatch_orders d on d.id = dl.dispatch_id
    where dl.received_at >= '2026-07-15'::date
      and dl.wms_booked_at is null
      and coalesce(dl.quantity, 0) > 0
      and nullif(btrim(dl.item_code), '') is not null
  loop
    v_batch := coalesce(r.batch_no, '');
    select id, description, unit into v_item_id, v_desc, v_uom from public.items where code = r.item_code;
    insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values ('8BT', v_item_id, r.item_code, coalesce(r.description, v_desc), v_stage, 'GOODS-IN', v_batch, r.exp_date, r.quantity, v_uom)
    on conflict (warehouse_code, item_code, location_id, batch_no)
      do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name, created_at)
    values ('8BT', 'receipt', v_item_id, r.item_code, coalesce(r.description, v_desc), v_stage, 'GOODS-IN', v_batch, r.exp_date, r.quantity,
      'DO ' || coalesce(r.do_number, '') || case when nullif(r.warehouse_grn, '') is not null then ' · GRN ' || r.warehouse_grn else '' end || ' (backfill)',
      r.received_by, r.received_by_name, coalesce(r.received_at, now()));
    update public.dispatch_order_lines set wms_booked_at = now() where id = r.id;
  end loop;
end $$;

notify pgrst, 'reload schema';
