-- WMS9 transfer-only + cross-dock request reduction — PART 4 of 5: wms_crossdock_receive (allowed to book in at WMS9).
-- Run parts 1 to 5 in order, each on its own, in the Supabase SQL editor. Safe to re-run.
-- The full explanation is at the top of part 1.

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

-- END OF PART 4 of 5
