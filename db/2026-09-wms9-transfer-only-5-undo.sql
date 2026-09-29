-- WMS9 transfer-only + cross-dock request reduction — PART 5 of 5: wms_crossdock_undo (gives the request quantity back).
-- Run parts 1 to 5 in order, each on its own, in the Supabase SQL editor. Safe to re-run.
-- The full explanation is at the top of part 1.

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

-- END OF PART 5 of 5
