-- Let a cross-dock carry a raw-material return, not only a finished-goods line.
--
-- Why: GCH packs have been leaving the factory as material returns (root cause recorded
-- 17 Sep). The 📦 Finished goods tick fixes new ones; this clears the backlog that is
-- already sitting at the wrong building as returns.
--
-- What changes:
--   * wms_wh_transfer_lines gets do_return_id (a material_returns id) beside do_line_id.
--     A line points at one or the other, never both.
--   * wms_crossdock_send accepts either kind of id in p_line_ids (same signature).
--   * wms_crossdock_receive books a return through confirm_do_return, a finished-goods
--     line through confirm_do_line as before.
--   * wms_crossdock_undo sends returns back too (it used to skip any line without a
--     do_line_id). set_do_line_destination already takes either id, so it is unchanged.
--
-- Run in the Supabase SQL editor. Safe to re-run.

alter table public.wms_wh_transfer_lines add column if not exists do_return_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wms_wh_transfer_lines_do_return_fk') then
    alter table public.wms_wh_transfer_lines
      add constraint wms_wh_transfer_lines_do_return_fk
      foreign key (do_return_id) references public.material_returns(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'wms_wh_transfer_lines_one_source') then
    alter table public.wms_wh_transfer_lines
      add constraint wms_wh_transfer_lines_one_source
      check (num_nonnulls(do_line_id, do_return_id) <= 1);
  end if;
end $$;

create index if not exists wms_wh_transfer_lines_do_return_idx
  on public.wms_wh_transfer_lines (do_return_id) where do_return_id is not null;


CREATE OR REPLACE FUNCTION public.wms_crossdock_send(p_line_ids uuid[], p_to_warehouse text DEFAULT 'WMS9'::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_name text; v_tid uuid; v_no text;
  v_from_b text; v_to_b text; v_from_wh text; r record;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed to load a cross-dock'; end if;
  if coalesce(array_length(p_line_ids, 1), 0) = 0 then raise exception 'Tick what is going on the lorry.'; end if;

  select code into v_to_b from public.wms_buildings where warehouse_code = btrim(p_to_warehouse);
  if v_to_b is null then raise exception 'There is no building with warehouse code %.', p_to_warehouse; end if;

  -- The first id may be a finished-goods line or a raw-material return.
  if exists (select 1 from public.dispatch_order_lines where id = p_line_ids[1]) then
    v_from_wh := public.wms_do_line_wh(p_line_ids[1]);
  else
    v_from_wh := public.wms_do_return_wh(p_line_ids[1]);
  end if;
  select code into v_from_b from public.wms_buildings where warehouse_code = v_from_wh;
  if v_from_b is null then raise exception 'Could not tell which building these are standing at.'; end if;
  if v_from_wh = btrim(p_to_warehouse) then raise exception 'These are already addressed to %.', p_to_warehouse; end if;

  select full_name into v_name from public.profiles where id = auth.uid();

  insert into public.wms_wh_transfers
    (transfer_no, kind, from_building, from_warehouse, to_building, to_warehouse,
     remark, status, sent_by, sent_by_name)
  values ('WT-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'), 'crossdock',
          v_from_b, v_from_wh, v_to_b, btrim(p_to_warehouse),
          'Cross-dock: made by the factory for ' || v_to_b || '''s orders, loaded at ' || v_from_b || ' without entering its stock.',
          'Sent', auth.uid(), v_name)
  returning id, transfer_no into v_tid, v_no;

  foreach v_id in array p_line_ids loop
    select l.id, l.item_code, l.description, l.batch_no, l.exp_date, l.quantity, l.received_at,
           d.factory_code as fact, false as is_return into r
      from public.dispatch_order_lines l join public.dispatch_orders d on d.id = l.dispatch_id
     where l.id = v_id;
    if not found then
      select m.id, m.item_code, m.description, m.batch_no, m.exp_date, m.quantity, m.received_at,
             coalesce(d.factory_code, m.factory_code) as fact, true as is_return into r
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
            case when r.is_return then r.id else null end);

    -- Takes either kind of id.
    perform public.set_do_line_destination(v_id, btrim(p_to_warehouse));
  end loop;

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
declare v_t public.wms_wh_transfers; v_name text; v_n int := 0; r record;
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
  end loop;

  update public.wms_wh_transfers
     set status = 'Cancelled',
         remark = coalesce(remark, '') || ' · Called back '
                  || to_char(now(), 'DD Mon HH24:MI') || ' by ' || coalesce(v_name, 'someone')
                  || case when nullif(btrim(coalesce(p_reason, '')), '') is not null then ': ' || btrim(p_reason) else '' end
   where id = p_transfer_id;

  return v_n;
end $function$;
