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

-- WMS9 transfer-only + cross-dock request reduction — PART 1 of 5: the WMS9 flag, the 12-line exemption, and the request-reduction helper.
-- Run parts 1 to 5 in order, each on its own, in the Supabase SQL editor. Safe to re-run.

-- Lines already on their way to WMS9 when the rule came in (12 on 29 Sep) are received there as
-- before — blocking goods already on a lorry only strands them at the dock. Delete a row to
-- withdraw its exemption.
create table if not exists public.wms_transfer_only_exempt (
  line_id uuid primary key,          -- a dispatch_order_lines id or a material_returns id
  created_at timestamptz not null default now()
);
alter table public.wms_transfer_only_exempt enable row level security;
drop policy if exists transfer_only_exempt_read on public.wms_transfer_only_exempt;
create policy transfer_only_exempt_read on public.wms_transfer_only_exempt for select using (has_perm('warehouse', 'view'));

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'wms_buildings' and column_name = 'transfer_only') then
    alter table public.wms_buildings add column transfer_only boolean not null default false;
    -- Only on first creation, so a later change by Head Office is not undone by a re-run.
    update public.wms_buildings set transfer_only = true where warehouse_code = 'WMS9';

    insert into public.wms_transfer_only_exempt (line_id)
    select l.id from public.dispatch_order_lines l
     where l.received_at is null and public.wms_do_line_wh(l.id) = 'WMS9'
    union
    select m.id from public.material_returns m
     where m.received_at is null and public.wms_do_return_wh(m.id) = 'WMS9'
    on conflict do nothing;
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

-- END OF PART 1 of 5
