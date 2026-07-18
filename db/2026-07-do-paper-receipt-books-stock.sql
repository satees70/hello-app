-- Paper-received delivery lines must ENTER WAREHOUSE STOCK, same as "Photo + confirm".
--
-- Bug: "Mark received on paper" (approve_do_paper_receipt) only stamped received_at on the line —
-- it never booked the goods into WMS. So a production DO accepted on paper (e.g. DO015-2607/0067)
-- showed as "received" but the stock never appeared in the warehouse / never triggered auto-pick.
-- Only "Photo + confirm" (confirm_do_line) was booking stock.
--
-- Fix: factor the stock-booking out of confirm_do_line into a helper (_wms_book_do_line) and call it
-- from BOTH paths. Booking is marker-guarded (wms_booked_at) so it happens exactly once, and it emits
-- a 'receipt' move that fires the auto-pick trigger. Then re-run the 15-Jul backfill to catch every
-- line already received-on-paper that never made it into stock.
--
-- Run in the Supabase SQL editor. Safe to re-run. Depends on db/2026-07-wms-auto-repick.sql.

-- ============================ shared helper · book ONE delivery line into GOODS-IN ============================
create or replace function public._wms_book_do_line(p_line_id uuid, p_actor uuid, p_actor_name text)
  returns void language plpgsql security definer set search_path = public as $$
declare v_line public.dispatch_order_lines; v_item_id uuid; v_desc text; v_uom text;
  v_stage uuid; v_dono text; v_grn text; v_batch text;
begin
  select * into v_line from public.dispatch_order_lines where id = p_line_id;
  if not found then return; end if;
  -- exactly once, and only real goods
  if v_line.wms_booked_at is not null then return; end if;
  if coalesce(v_line.quantity, 0) <= 0 or nullif(btrim(v_line.item_code), '') is null then return; end if;

  v_batch := coalesce(v_line.batch_no, '');
  select id, description, unit into v_item_id, v_desc, v_uom from public.items where code = v_line.item_code;
  select id into v_stage from public.wms_locations where warehouse_code = '8BT' and code = 'GOODS-IN';
  if v_stage is null then return; end if;
  select do_number, warehouse_grn into v_dono, v_grn from public.dispatch_orders where id = v_line.dispatch_id;

  insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
  values ('8BT', v_item_id, v_line.item_code, coalesce(v_line.description, v_desc), v_stage, 'GOODS-IN', v_batch, v_line.exp_date, v_line.quantity, v_uom)
  on conflict (warehouse_code, item_code, location_id, batch_no)
    do update set quantity = wms_stock.quantity + excluded.quantity, exp_date = coalesce(excluded.exp_date, wms_stock.exp_date), updated_at = now();
  insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
    to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
  values ('8BT', 'receipt', v_item_id, v_line.item_code, coalesce(v_line.description, v_desc), v_stage, 'GOODS-IN', v_batch, v_line.exp_date, v_line.quantity,
    'DO ' || coalesce(v_dono, '') || case when nullif(v_grn, '') is not null then ' · GRN ' || v_grn else '' end, p_actor, p_actor_name);
  update public.dispatch_order_lines set wms_booked_at = now() where id = p_line_id;
end $$;
grant execute on function public._wms_book_do_line(uuid, uuid, text) to authenticated, service_role;

-- ============================ confirm_do_line now delegates booking to the helper ============================
create or replace function public.confirm_do_line(p_line_id uuid, p_photo_path text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_do uuid; v_pending int; v_line public.dispatch_order_lines;
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

  perform public._wms_book_do_line(p_line_id, auth.uid(), v_name);

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

-- ============================ paper receipt now books stock too ============================
create or replace function public.approve_do_paper_receipt(p_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_req public.do_paper_receipt_requests; v_recv text; v_appr text; v_actor uuid; r record;
begin
  if not public.is_ho_or_admin() then raise exception 'Only Head Office can approve a paper receipt'; end if;
  select * into v_req from public.do_paper_receipt_requests where id = p_id;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'Pending' then raise exception 'This request was already handled'; end if;
  select full_name into v_appr from public.profiles where id = auth.uid();
  v_recv  := coalesce(v_req.requested_by_name, v_appr);
  v_actor := coalesce(v_req.requested_by, auth.uid());

  if v_req.line_id is not null then
    if v_req.line_kind = 'return' then
      update public.material_returns
        set received_at = coalesce(received_at, now()), received_by = v_actor, received_by_name = v_recv
        where id = v_req.line_id and received_at is null;
    else
      -- book the finished-goods line into WMS stock (only if it was still outstanding)
      for r in
        update public.dispatch_order_lines
          set received_at = coalesce(received_at, now()), received_by = v_actor, received_by_name = v_recv
          where id = v_req.line_id and received_at is null
          returning id
      loop
        perform public._wms_book_do_line(r.id, v_actor, v_recv);
      end loop;
    end if;
  else
    -- whole DO: book every FG line that this approval newly received
    for r in
      update public.dispatch_order_lines
        set received_at = coalesce(received_at, now()), received_by = v_actor, received_by_name = v_recv
        where dispatch_id = v_req.dispatch_id and received_at is null
        returning id
    loop
      perform public._wms_book_do_line(r.id, v_actor, v_recv);
    end loop;
    update public.material_returns
      set received_at = coalesce(received_at, now()), received_by = v_actor, received_by_name = v_recv
      where dispatch_id = v_req.dispatch_id and received_at is null;
  end if;
  perform public._do_receipt_rollup(v_req.dispatch_id, v_recv);

  update public.do_paper_receipt_requests
    set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_appr, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_do_paper_receipt(uuid) to authenticated, anon, service_role;

-- ============================ backfill · book paper-received lines already marked received (on/after 2026-07-15) ============================
-- Same guard as the auto-repick backfill: books only lines received but never entered into WMS. Re-running is a no-op.
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
      and not exists (
        select 1 from public.wms_stock_moves m
        where m.move_type = 'receipt' and m.item_code = dl.item_code
          and m.reference like 'DO ' || d.do_number || '%')
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
