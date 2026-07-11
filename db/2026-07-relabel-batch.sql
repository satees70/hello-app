-- 2026-07 · Allow correcting the BATCH NUMBER on an already-received DO line
-- ----------------------------------------------------------------------------
-- Until now, any item/qty/unit/batch change on a received Goods-Received line
-- was rejected with "delete it and receive again", because those fields move
-- stock. But a BATCH NUMBER is only a LABEL — it doesn't change quantity, item or
-- code. So this updates approve_do_change to relabel the batch in place on both
-- the delivery order line AND its linked stock lot, with NO stock movement. Item,
-- quantity and unit changes on a received line still require delete + re-receive.
--
-- Run this in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

create or replace function public.approve_do_change(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.do_change_requests; v_l public.delivery_order_lines; v_lot public.stock_lots; v_name text; v_reqid uuid;
begin
  if my_factory_code() <> 'HEAD_OFFICE' then raise exception 'Only Head Office can approve'; end if;
  select * into r from public.do_change_requests where id = p_id;
  if not found or r.status <> 'Pending' then raise exception 'Not a pending request'; end if;
  select * into v_l from public.delivery_order_lines where id = r.line_id;

  if r.request_type = 'edit' then
    if not found then raise exception 'That line no longer exists'; end if;
    if r.field not in ('item_code','description','quantity','unit','batch_no') then raise exception 'Field % cannot be edited', r.field; end if;
    -- item/qty/unit move stock, so a received line must be deleted & received again.
    -- A batch number is only a LABEL: relabel it in place (line + stock lot), no stock movement.
    if v_l.received_at is not null and r.field in ('item_code','quantity','unit') then
      raise exception 'Line already received — delete it and receive again to change %', r.field;
    end if;
    if r.field = 'batch_no' and v_l.received_at is not null and v_l.stock_lot_id is not null then
      update public.stock_lots set batch_no = nullif(r.new_value,'') where id = v_l.stock_lot_id;
    end if;
    if r.field = 'quantity' then
      update public.delivery_order_lines set quantity = nullif(r.new_value,'')::numeric where id = r.line_id;
    else
      execute format('update public.delivery_order_lines set %I = $1 where id = $2', r.field) using nullif(r.new_value,''), r.line_id;
    end if;

  elsif r.request_type = 'correct_qty' then
    -- Fix the quantity that was received into stock; re-book the difference.
    if not found then raise exception 'That line no longer exists'; end if;
    if v_l.received_at is null then raise exception 'Line is not received yet — just receive it with the right quantity'; end if;
    if v_l.stock_lot_id is null then raise exception 'This receipt predates the feature — correct its stock manually'; end if;
    select * into v_lot from public.stock_lots where id = v_l.stock_lot_id;
    if not found then raise exception 'The stock lot for this line no longer exists'; end if;
    declare v_new numeric := nullif(r.new_value,'')::numeric; v_old numeric := coalesce(v_l.received_qty, 0); v_delta numeric;
    begin
      if v_new is null or v_new < 0 then raise exception 'Enter a valid corrected quantity'; end if;
      v_delta := v_new - v_old;
      if v_delta < 0 and v_lot.qty_remaining < (-v_delta) then
        raise exception 'Cannot reduce below what is left — % already used from this batch', (v_old - v_lot.qty_remaining);
      end if;
      update public.stock_lots set qty_remaining = qty_remaining + v_delta, qty_received = qty_received + v_delta where id = v_lot.id;
      update public.item_stock set quantity = quantity + v_delta, updated_at = now() where item_id = v_lot.item_id and factory_code = v_lot.factory_code;
      update public.delivery_order_lines set received_qty = v_new where id = r.line_id;
      if v_lot.request_item_id is not null then
        update public.material_request_items set received_qty = greatest(received_qty + v_delta, 0) where id = v_lot.request_item_id;
        select request_id into v_reqid from public.material_request_items where id = v_lot.request_item_id;
        update public.material_requests set status =
          case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = v_reqid) then 'Fulfilled'
               when (select bool_or(received_qty > 0) from public.material_request_items where request_id = v_reqid) then 'Partially Received'
               else 'Open' end
        where id = v_reqid;
      end if;
    end;

  elsif r.request_type = 'delete' then
    if found and v_l.received_at is not null then
      if v_l.stock_lot_id is null then raise exception 'This receipt predates the feature — reverse its stock manually, then delete'; end if;
      select * into v_lot from public.stock_lots where id = v_l.stock_lot_id;
      if found then
        if v_lot.qty_remaining < coalesce(v_l.received_qty, 0) then
          raise exception 'This batch has already been partly used in production — cannot reverse automatically. Fix stock manually.';
        end if;
        update public.stock_lots set qty_remaining = qty_remaining - coalesce(v_l.received_qty, 0) where id = v_lot.id;
        update public.item_stock set quantity = quantity - coalesce(v_l.received_qty, 0), updated_at = now()
          where item_id = v_lot.item_id and factory_code = v_lot.factory_code;
        if v_lot.request_item_id is not null then
          update public.material_request_items set received_qty = greatest(received_qty - coalesce(v_l.received_qty, 0), 0) where id = v_lot.request_item_id;
          select request_id into v_reqid from public.material_request_items where id = v_lot.request_item_id;
          update public.material_requests set status =
            case when (select bool_and(received_qty >= requested_qty) from public.material_request_items where request_id = v_reqid) then 'Fulfilled'
                 when (select bool_or(received_qty > 0) from public.material_request_items where request_id = v_reqid) then 'Partially Received'
                 else 'Open' end
          where id = v_reqid;
        end if;
      end if;
    end if;
    delete from public.delivery_order_lines where id = r.line_id;
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  update public.do_change_requests set status = 'Approved', reviewed_by = auth.uid(), reviewed_by_name = v_name, reviewed_at = now() where id = p_id;
end $$;
grant execute on function public.approve_do_change(uuid) to authenticated;
