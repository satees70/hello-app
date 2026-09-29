-- WMS9 transfer-only + cross-dock request reduction — PART 3 of 5: wms_crossdock_send (reduces the oldest open request).
-- Run parts 1 to 5 in order, each on its own, in the Supabase SQL editor. Safe to re-run.
-- The full explanation is at the top of part 1.

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

-- END OF PART 3 of 5
