-- WMS9 receives only by building transfer, and a cross-dock pays off WMS9's oldest open request.
--
-- Why (owner, 29 Sep): "disable WMS9 button in receive from production — all items received in
-- WMS9 shall go through building transfer — and if there is an open building transfer [request]
-- then make sure to reduce that older order." Also: a cross-dock must be allowed when the delivery
-- is not linked to a request.
--
-- What changes:
--   * wms_buildings.transfer_only — set for WMS9. Such a building cannot have a delivery line
--     addressed to it (set_do_line_destination) or confirmed at it (confirm_do_line /
--     confirm_do_return) except from inside a cross-dock. Head Office can clear the flag to undo.
--   * wms_crossdock_send: when the delivery is NOT linked to a request, each line is counted
--     against the destination's open requests for that item, oldest first (qty_sent goes up, and
--     an open pick job for that request is cut by the same amount). A linked delivery is left to
--     the existing receipt triggers, so nothing is counted twice.
--   * wms_crossdock_undo gives those quantities back.
--   * wms_crossdock_receive: unchanged apart from being allowed to confirm at WMS9.
--
-- Needs db/2026-09-crossdock-returns.sql first (already run).
-- Run in the Supabase SQL editor. Safe to re-run.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'wms_buildings' and column_name = 'transfer_only') then
    alter table public.wms_buildings add column transfer_only boolean not null default false;
    -- Only on first creation, so a later change by Head Office is not undone by a re-run.
    update public.wms_buildings set transfer_only = true where warehouse_code = 'WMS9';
  end if;
end $$;

create or replace function public.wms_is_transfer_only(p_warehouse text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $$
  select coalesce(bool_or(transfer_only), false) from public.wms_buildings where warehouse_code = p_warehouse
$$;

-- Set (transaction-local) only by the cross-dock functions below.
create or replace function public._wms_in_crossdock()
 returns boolean
 language sql
 stable
as $$ select coalesce(current_setting('wms.crossdock', true), '') = '1' $$;

-- What each cross-dock line took off which request line, so a call-back can give it back.
create table if not exists public.wms_crossdock_request_fills (
  id uuid primary key default gen_random_uuid(),
  transfer_line_id uuid not null references public.wms_wh_transfer_lines(id) on delete cascade,
  request_line_id uuid not null references public.wms_wh_request_lines(id) on delete cascade,
  order_line_id uuid,             -- the pick-job line that was cut, if there was one
  qty numeric not null,
  reversed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists wms_crossdock_request_fills_tl_idx on public.wms_crossdock_request_fills (transfer_line_id);
alter table public.wms_crossdock_request_fills enable row level security;
drop policy if exists xdock_fills_read on public.wms_crossdock_request_fills;
create policy xdock_fills_read on public.wms_crossdock_request_fills for select using (has_perm('warehouse', 'view'));


-- Count p_qty of p_item against p_to_wh's open requests, oldest first. Returns what was counted.
create or replace function public._wms_xdock_fill_requests(p_transfer_line_id uuid, p_to_wh text, p_item text, p_qty numeric)
 returns numeric
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r record; v_left numeric := coalesce(p_qty, 0); v_take numeric; v_cap numeric; v_total numeric := 0;
        v_ol record;
begin
  for r in
    select l.id as line_id, l.request_id, rq.request_no,
           greatest(coalesce(l.qty_requested, 0) - coalesce(l.qty_sent, 0), 0) as owed
      from public.wms_wh_request_lines l
      join public.wms_wh_requests rq on rq.id = l.request_id
     where rq.need_warehouse = p_to_wh
       and rq.status in ('Open', 'Partially Sent')
       and upper(btrim(l.item_code)) = upper(btrim(p_item))
       and greatest(coalesce(l.qty_requested, 0) - coalesce(l.qty_sent, 0), 0) > 0
     order by rq.created_at, l.id
     for update of l
  loop
    exit when v_left <= 0;
    v_cap := r.owed;

    -- ⚠️ An open pick job for the request may already have bags in a trolley. Only the part nobody
    -- has picked can be paid off here, or the same need is filled twice.
    select ol.id, coalesce(ol.quantity, 0) as q, coalesce(ol.qty_picked, 0) as p into v_ol
      from public.wms_orders o
      join public.wms_order_lines ol on ol.order_id = o.id and upper(ol.item_code) = upper(btrim(p_item))
     where o.source = 'transfer' and o.order_no = r.request_no
       and o.status not in ('Cancelled', 'Dispatched')
     limit 1;
    if found then v_cap := least(v_cap, greatest(v_ol.q - v_ol.p, 0)); end if;

    v_take := least(v_left, v_cap);
    if v_take <= 0 then v_ol := null; continue; end if;

    update public.wms_wh_request_lines set qty_sent = coalesce(qty_sent, 0) + v_take where id = r.line_id;
    if v_ol.id is not null then
      update public.wms_order_lines set quantity = greatest(0, coalesce(quantity, 0) - v_take) where id = v_ol.id;
    end if;
    insert into public.wms_crossdock_request_fills (transfer_line_id, request_line_id, order_line_id, qty)
    values (p_transfer_line_id, r.line_id, v_ol.id, v_take);

    update public.wms_wh_requests
       set status = case when not exists (select 1 from public.wms_wh_request_lines
                                           where request_id = r.request_id and (coalesce(qty_requested, 0) - coalesce(qty_sent, 0)) > 0)
                         then 'Fulfilled' else 'Partially Sent' end,
           closed_at = case when not exists (select 1 from public.wms_wh_request_lines
                                              where request_id = r.request_id and (coalesce(qty_requested, 0) - coalesce(qty_sent, 0)) > 0)
                            then now() else null end
     where id = r.request_id and status not in ('Cancelled', 'Fulfilled');

    v_left := v_left - v_take; v_total := v_total + v_take; v_ol := null;
  end loop;
  return v_total;
end $function$;


CREATE OR REPLACE FUNCTION public.set_do_line_destination(p_line_id uuid, p_warehouse_code text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text; v_fg public.dispatch_order_lines; v_ret public.material_returns;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false)
          or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can switch a delivery line';
  end if;
  if not public.wms_valid_destination(p_warehouse_code) then
    raise exception 'That warehouse has no GOODS-IN bin — it cannot receive goods yet';
  end if;
  -- ⚠️ A transfer-only building (WMS9) is reached by a building transfer, never by re-addressing.
  if public.wms_is_transfer_only(p_warehouse_code) and not public._wms_in_crossdock() then
    raise exception '% only takes goods by building transfer — receive it here and use Send on to %.', p_warehouse_code, p_warehouse_code;
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();

  select * into v_fg from public.dispatch_order_lines where id = p_line_id;
  if found then
    if v_fg.received_at is not null then
      raise exception 'That item has already been received — it cannot be sent to another warehouse now';
    end if;
    update public.dispatch_order_lines
       set warehouse_code = p_warehouse_code, warehouse_changed_at = now(),
           warehouse_changed_by = auth.uid(), warehouse_changed_by_name = v_name
     where id = p_line_id;
    return;
  end if;

  select * into v_ret from public.material_returns where id = p_line_id;
  if not found then raise exception 'Delivery line not found'; end if;
  if v_ret.received_at is not null then
    raise exception 'That return has already been received — it cannot be sent to another warehouse now';
  end if;
  update public.material_returns
     set warehouse_code = p_warehouse_code, warehouse_changed_at = now(),
         warehouse_changed_by = auth.uid(), warehouse_changed_by_name = v_name
   where id = p_line_id;
end $function$;


CREATE OR REPLACE FUNCTION public.confirm_do_line(p_line_id uuid, p_photo_path text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text; v_do uuid; v_pending int; v_line public.dispatch_order_lines; v_wh text; v_mine text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can confirm a delivery line';
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  select * into v_line from public.dispatch_order_lines where id = p_line_id;
  if not found then raise exception 'Delivery line not found'; end if;

  -- Someone pinned to one building must not receive goods addressed to the other. If the
  -- lorry really came here, the line is switched first -- that keeps the paperwork honest.
  v_wh := public.wms_do_line_wh(p_line_id);
  v_mine := public.my_warehouse_code();
  if v_mine is not null and v_wh is distinct from v_mine then
    raise exception 'This item is addressed to another warehouse — switch it to yours first if it arrived here';
  end if;
  -- ⚠️ A transfer-only building (WMS9) books goods in only off a cross-dock load.
  if public.wms_is_transfer_only(v_wh) and not public._wms_in_crossdock() then
    raise exception '% only takes goods by building transfer — switch this line to the unloading building, receive it there and send it on.', v_wh;
  end if;

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
end $function$;


CREATE OR REPLACE FUNCTION public.confirm_do_return(p_return_id uuid, p_photo_path text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_name text; v_do uuid; v_ret public.material_returns;
  v_item_id uuid; v_desc text; v_uom text; v_stage uuid; v_dono text; v_grn text; v_batch text;
  v_wh text; v_mine text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can confirm a return';
  end if;

  v_wh := public.wms_do_return_wh(p_return_id);
  if v_wh is null then raise exception 'Return line not found'; end if;
  v_mine := public.my_warehouse_code();
  if v_mine is not null and v_wh is distinct from v_mine then
    raise exception 'This return is addressed to another warehouse — switch it to yours first if it arrived here';
  end if;
  -- ⚠️ A transfer-only building (WMS9) books goods in only off a cross-dock load.
  if public.wms_is_transfer_only(v_wh) and not public._wms_in_crossdock() then
    raise exception '% only takes goods by building transfer — switch this line to the unloading building, receive it there and send it on.', v_wh;
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  update public.material_returns
     set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name,
         photo_path = coalesce(nullif(p_photo_path, ''), photo_path)
   where id = p_return_id returning * into v_ret;
  if v_ret.id is null then raise exception 'Return line not found'; end if;
  v_do := v_ret.dispatch_id;

  if v_ret.wms_booked_at is null and coalesce(v_ret.quantity, 0) > 0 and nullif(btrim(v_ret.item_code), '') is not null then
    v_batch := coalesce(v_ret.batch_no, '');
    select id, description, unit into v_item_id, v_desc, v_uom from public.items where code = v_ret.item_code;
    select id into v_stage from public.wms_locations where warehouse_code = v_wh and code = 'GOODS-IN';
    select do_number, warehouse_grn into v_dono, v_grn from public.dispatch_orders where id = v_do;
    if v_stage is null then raise exception 'Warehouse % has no GOODS-IN bin — the return cannot be booked in', v_wh; end if;
    insert into public.wms_stock (warehouse_code, item_id, item_code, description, location_id, location_code, batch_no, exp_date, quantity, uom)
    values (v_wh, v_item_id, v_ret.item_code, coalesce(v_ret.description, v_desc), v_stage, 'GOODS-IN', v_batch, v_ret.exp_date, v_ret.quantity, v_uom)
    on conflict (warehouse_code, item_code, location_id, batch_no, exp_date)
      do update set quantity = wms_stock.quantity + excluded.quantity, updated_at = now();
    insert into public.wms_stock_moves (warehouse_code, move_type, item_id, item_code, description,
      to_location_id, to_location_code, batch_no, exp_date, quantity, reference, moved_by, moved_by_name)
    values (v_wh, 'receipt', v_item_id, v_ret.item_code, coalesce(v_ret.description, v_desc), v_stage, 'GOODS-IN', v_batch, v_ret.exp_date, v_ret.quantity,
      'DO ' || coalesce(v_dono, '') || case when nullif(v_grn, '') is not null then ' · GRN ' || v_grn else '' end || ' (return)', auth.uid(), v_name);
    update public.material_returns set wms_booked_at = now() where id = p_return_id;
  end if;

  perform public._do_receipt_rollup(v_do, v_name);
end $function$;


CREATE OR REPLACE FUNCTION public.wms_crossdock_send(p_line_ids uuid[], p_to_warehouse text DEFAULT 'WMS9'::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_name text; v_tid uuid; v_no text; v_tlid uuid; v_filled numeric; v_fill_total numeric := 0;
  v_from_b text; v_to_b text; v_from_wh text; v_to_wh text := btrim(p_to_warehouse); r record;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to load a cross-dock'; end if;
  if coalesce(array_length(p_line_ids, 1), 0) = 0 then raise exception 'Tick what is going on the lorry.'; end if;

  select code into v_to_b from public.wms_buildings where warehouse_code = v_to_wh;
  if v_to_b is null then raise exception 'There is no building with warehouse code %.', p_to_warehouse; end if;

  -- The first id may be a finished-goods line or a raw-material return.
  if exists (select 1 from public.dispatch_order_lines where id = p_line_ids[1]) then
    v_from_wh := public.wms_do_line_wh(p_line_ids[1]);
  else
    v_from_wh := public.wms_do_return_wh(p_line_ids[1]);
  end if;
  select code into v_from_b from public.wms_buildings where warehouse_code = v_from_wh;
  if v_from_b is null then raise exception 'Could not tell which building these are standing at.'; end if;
  if v_from_wh = v_to_wh then raise exception 'These are already addressed to %.', p_to_warehouse; end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  -- Lets set_do_line_destination address these to a transfer-only building. This transaction only.
  perform set_config('wms.crossdock', '1', true);

  insert into public.wms_wh_transfers
    (transfer_no, kind, from_building, from_warehouse, to_building, to_warehouse,
     remark, status, sent_by, sent_by_name)
  values ('WT-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'), 'crossdock',
          v_from_b, v_from_wh, v_to_b, v_to_wh,
          'Cross-dock: made by the factory for ' || v_to_b || '''s orders, loaded at ' || v_from_b || ' without entering its stock.',
          'Sent', auth.uid(), v_name)
  returning id, transfer_no into v_tid, v_no;

  foreach v_id in array p_line_ids loop
    select l.id, l.item_code, l.description, l.batch_no, l.exp_date, l.quantity, l.received_at,
           d.factory_code as fact, d.wh_request_id, false as is_return into r
      from public.dispatch_order_lines l join public.dispatch_orders d on d.id = l.dispatch_id
     where l.id = v_id;
    if not found then
      select m.id, m.item_code, m.description, m.batch_no, m.exp_date, m.quantity, m.received_at,
             coalesce(d.factory_code, m.factory_code) as fact, d.wh_request_id, true as is_return into r
        from public.material_returns m left join public.dispatch_orders d on d.id = m.dispatch_id
       where m.id = v_id;
      if not found then raise exception 'One of those delivery lines no longer exists.'; end if;
    end if;
    if r.received_at is not null then
      raise exception '% has already been received — it cannot be loaded on as a cross-dock now.', r.item_code;
    end if;

    insert into public.wms_wh_transfer_lines
      (transfer_id, item_id, item_code, description, batch_no, exp_date, uom,
       from_location_code, qty_sent, do_line_id, do_return_id)
    values (v_tid,
            -- ⚠️ LOOKED UP, not copied: the delivery line has only a code.
            (select i.id from public.items i where upper(i.code) = upper(r.item_code) limit 1),
            r.item_code, r.description, coalesce(r.batch_no, ''), r.exp_date, null,
            'FACTORY ' || coalesce(r.fact, ''), r.quantity,
            case when r.is_return then null else r.id end,
            case when r.is_return then r.id else null end)
    returning id into v_tlid;

    -- Takes either kind of id.
    perform public.set_do_line_destination(v_id, v_to_wh);

    -- ⚠️ ONLY WHEN THE DELIVERY IS NOT LINKED TO A REQUEST. A linked one is counted by the receipt
    -- triggers (zz_do_line_fills_wh_request / zz_do_return_fills_wh_request) when it is booked in;
    -- counting it here as well would pay the same request twice.
    if r.wh_request_id is null then
      v_filled := public._wms_xdock_fill_requests(v_tlid, v_to_wh, r.item_code, r.quantity);
      v_fill_total := v_fill_total + v_filled;
    end if;
  end loop;

  if v_fill_total > 0 then
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values (v_to_wh, 'wms', '🚚 A cross-dock is covering your request',
            v_no || ' from ' || v_from_b || ' carries ' || v_fill_total::text
              || ' against your open requests (oldest first) — that much less to send from the other building.',
            '/wms/wh-transfers', 'xdockfill:' || v_tid)
    on conflict (ref) do nothing;
  end if;

  return v_no;
end $function$;


CREATE OR REPLACE FUNCTION public.wms_crossdock_receive(p_transfer_id uuid, p_lines jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_t public.wms_wh_transfers; v_name text; e jsonb; v_l public.wms_wh_transfer_lines;
  v_qty numeric; v_batch text; v_short numeric; v_fact text; v_do text; v_msg text; v_any_short boolean := false;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to receive a transfer'; end if;
  select * into v_t from public.wms_wh_transfers where id = p_transfer_id;
  if not found then raise exception 'That transfer no longer exists.'; end if;
  if v_t.kind <> 'crossdock' then
    raise exception 'That is an ordinary transfer — receive it on the transfer screen.';
  end if;
  if v_t.status in ('Received', 'Cancelled') then raise exception 'That transfer is already %.', lower(v_t.status); end if;
  -- ⚠️ Only the building it was sent TO may count it in. SECURITY DEFINER bypasses RLS, so the
  -- check has to be explicit, and it names both sides — a guard that blames only the record is why
  -- the customer-return one went four days unreported.
  if not public.wms_sees(v_t.to_building) then
    raise exception 'This load is for %, and you are not there.', v_t.to_building;
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  -- Lets confirm_do_line / confirm_do_return book in at a transfer-only building. This transaction only.
  perform set_config('wms.crossdock', '1', true);

  for e in select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    select * into v_l from public.wms_wh_transfer_lines
     where id = (e->>'line_id')::uuid and transfer_id = p_transfer_id;
    if not found then raise exception 'One of those lines is not on this load.'; end if;

    v_qty := coalesce((e->>'qty')::numeric, v_l.qty_sent);
    v_batch := nullif(btrim(coalesce(e->>'batch', '')), '');
    if v_qty < 0 then raise exception 'A received quantity cannot be negative.'; end if;

    -- The stock is booked ONCE, here, through the ordinary delivery path — so a cross-dock lands
    -- in exactly the same place, with the same moves behind it, as any other factory receipt.
    -- A raw-material return goes through the return path for the same reason.
    if v_qty > 0 then
      if v_l.do_line_id is not null then
        if v_batch is not null and v_batch <> coalesce(v_l.batch_no, '') then
          update public.dispatch_order_lines set batch_no = v_batch where id = v_l.do_line_id;
        end if;
        perform public.confirm_do_line(v_l.do_line_id, null);
      elsif v_l.do_return_id is not null then
        if v_batch is not null and v_batch <> coalesce(v_l.batch_no, '') then
          update public.material_returns set batch_no = v_batch where id = v_l.do_return_id;
        end if;
        perform public.confirm_do_return(v_l.do_return_id, null);
      end if;
    end if;

    update public.wms_wh_transfer_lines set qty_received = v_qty where id = v_l.id;

    v_short := coalesce(v_l.qty_sent, 0) - v_qty;
    if v_short <> 0 or (v_batch is not null and v_batch <> coalesce(v_l.batch_no, '')) then
      v_any_short := true;
      -- ⚠️ THE FACTORY IS TOLD, NOT THE SENDING BUILDING. Owner: "missmatch triggers to production
      -- directly." WMS8B never opened the pallet — it put it on a lorry — so a short count or a
      -- wrong batch is a question for whoever packed it.
      v_fact := null; v_do := null;
      if v_l.do_line_id is not null then
        select d.factory_code, d.do_number into v_fact, v_do
          from public.dispatch_order_lines l join public.dispatch_orders d on d.id = l.dispatch_id
         where l.id = v_l.do_line_id;
      elsif v_l.do_return_id is not null then
        select coalesce(d.factory_code, m.factory_code), d.do_number into v_fact, v_do
          from public.material_returns m left join public.dispatch_orders d on d.id = m.dispatch_id
         where m.id = v_l.do_return_id;
      end if;
      v_msg := format('%s: sent %s, received %s%s',
                 v_l.item_code, v_l.qty_sent, v_qty,
                 case when v_batch is not null and v_batch <> coalesce(v_l.batch_no, '')
                      then format(' · batch on the bags is %s, the delivery said %s', v_batch, coalesce(nullif(v_l.batch_no, ''), 'none'))
                      else '' end);
      insert into public.notifications (factory_code, type, title, body, link, ref)
      values (coalesce(v_fact, 'HEAD_OFFICE'), 'crossdock_mismatch',
              format('Cross-dock difference on %s', coalesce(v_do, v_t.transfer_no)),
              v_msg, '/wms/wh-transfers',
              -- One per LINE for ever, so correcting it later does not fire a second.
              'xdock:' || v_l.id)
      on conflict (ref) do nothing;
    end if;
  end loop;

  update public.wms_wh_transfers
     set status = case when exists (select 1 from public.wms_wh_transfer_lines
                                     where transfer_id = p_transfer_id and qty_received < qty_sent)
                       then 'Short' else 'Received' end,
         received_by = auth.uid(), received_by_name = v_name, received_at = now()
   where id = p_transfer_id;

  if v_any_short then
    -- Head Office too: a difference on goods that crossed a road is worth two people seeing.
    insert into public.notifications (factory_code, type, title, body, link, ref)
    values ('HEAD_OFFICE', 'crossdock_mismatch',
            format('Cross-dock %s came in short or re-batched', v_t.transfer_no),
            format('%s → %s. Counted in by %s.', v_t.from_building, v_t.to_building, coalesce(v_name, 'someone')),
            '/wms/wh-transfers', 'xdockho:' || p_transfer_id)
    on conflict (ref) do nothing;
  end if;
end $function$;


CREATE OR REPLACE FUNCTION public.wms_crossdock_undo(p_transfer_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_t public.wms_wh_transfers; v_name text; v_n int := 0; r record; f record;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to call a load back'; end if;

  select * into v_t from public.wms_wh_transfers where id = p_transfer_id;
  if not found then raise exception 'That transfer no longer exists.'; end if;
  if v_t.kind <> 'crossdock' then
    raise exception 'That is an ordinary transfer — call it back from the transfer screen, which puts the stock back in PUT-BACK.';
  end if;
  if v_t.status = 'Cancelled' then raise exception 'That load was already called back.'; end if;

  -- ⚠️ ANYTHING RECEIVED AT THE FAR END ENDS IT. Their books hold the goods now.
  if exists (select 1 from public.wms_wh_transfer_lines where transfer_id = p_transfer_id and coalesce(qty_received, 0) > 0)
     or v_t.status in ('Received', 'Short') then
    raise exception 'Part of % has already been counted in at %. It cannot be called back — they must send it back as a transfer.', v_t.transfer_no, v_t.to_building;
  end if;

  -- Either side may call it back: the building that loaded it (it never left the floor) or the one
  -- expecting it (it never turned up). Both are looking at the same wrong lorry.
  if not (public.wms_sees(v_t.from_building) or public.wms_sees(v_t.to_building)) then
    raise exception 'That load is between % and %, and you are at neither.', v_t.from_building, v_t.to_building;
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();

  for r in select * from public.wms_wh_transfer_lines where transfer_id = p_transfer_id loop
    if coalesce(r.do_line_id, r.do_return_id) is not null then
      -- Back to the building that was holding them. `set_do_line_destination` takes either a
      -- finished-goods line or a return, and refuses one that has been received — the same guard
      -- again from the other direction.
      perform public.set_do_line_destination(coalesce(r.do_line_id, r.do_return_id), v_t.from_warehouse);
      v_n := v_n + 1;
    end if;

    -- ⚠️ THE REQUESTS GET THEIR QUANTITY BACK, or WMS9 is owed goods nothing is bringing.
    for f in select * from public.wms_crossdock_request_fills
              where transfer_line_id = r.id and reversed_at is null for update loop
      update public.wms_wh_request_lines
         set qty_sent = greatest(coalesce(qty_sent, 0) - f.qty, 0)
       where id = f.request_line_id;
      if f.order_line_id is not null then
        update public.wms_order_lines set quantity = coalesce(quantity, 0) + f.qty
         where id = f.order_line_id
           and exists (select 1 from public.wms_orders o where o.id = order_id
                        and o.status not in ('Cancelled', 'Dispatched'));
      end if;
      update public.wms_wh_requests rq
         set status = case when exists (select 1 from public.wms_wh_request_lines
                                         where request_id = rq.id and coalesce(qty_sent, 0) > 0)
                           then 'Partially Sent' else 'Open' end,
             closed_at = null
       where rq.id = (select request_id from public.wms_wh_request_lines where id = f.request_line_id)
         and rq.status <> 'Cancelled';
      update public.wms_crossdock_request_fills set reversed_at = now() where id = f.id;
    end loop;
  end loop;

  update public.wms_wh_transfers
     set status = 'Cancelled',
         remark = coalesce(remark, '') || ' · Called back '
                  || to_char(now(), 'DD Mon HH24:MI') || ' by ' || coalesce(v_name, 'someone')
                  || case when nullif(btrim(coalesce(p_reason, '')), '') is not null then ': ' || btrim(p_reason) else '' end
   where id = p_transfer_id;

  return v_n;
end $function$;
