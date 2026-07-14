-- Production Orders: a released pick run becomes a WMS order, picked and dispatched
-- exactly like a customer order, then received at the factory's Goods Received.
--
-- Stage 1 (this file): create_production_order() turns a released pick run into a
-- wms_orders row + lines, converting each loose-kg material to a BAG SKU × qty using
-- the last-used bag size for that material (fallback: most stock, then largest bag).
-- Materials already requested in bags are used as-is. It then flows through the normal
-- Orders-to-Pick screens.
--
-- Run in the Supabase SQL editor. Safe to re-run.

-- Allow a 'production' source, and remember which run/factory an order is for.
alter table public.wms_orders add column if not exists factory_code text;
alter table public.wms_orders add column if not exists pick_run text;
alter table public.wms_orders drop constraint if exists wms_orders_source_check;
alter table public.wms_orders add constraint wms_orders_source_check
  check (source in ('pdf', 'sql_account', 'manual', 'production'));

create or replace function public.create_production_order(p_pick_run text, p_factory text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_oid uuid; v_name text; v_facname text; v_line int := 0;
  m record; v_out_code text; v_out_uom text; v_out_qty numeric; v_kgpb numeric; v_itemid uuid; v_is_bag boolean;
begin
  if not (is_ho_or_admin() or has_perm('warehouse','edit')) then raise exception 'Not allowed to create a production order'; end if;

  -- Idempotent: one order per run+factory. Return the existing one if already created.
  select id into v_oid from wms_orders
    where source = 'production' and pick_run = p_pick_run and factory_code = p_factory and status <> 'Cancelled'
    limit 1;
  if v_oid is not null then return v_oid; end if;

  select full_name into v_name from profiles where id = auth.uid();
  select name into v_facname from factories where code = p_factory;

  insert into wms_orders (warehouse_code, source, order_no, customer_name, status, factory_code, pick_run, uploaded_by, uploaded_by_name)
  values ('8BT', 'production', p_pick_run, 'Production — ' || coalesce(v_facname, p_factory), 'Review', p_factory, p_pick_run, auth.uid(), v_name)
  returning id into v_oid;

  -- Pool the run's still-needed material lines by material.
  for m in
    select mri.item_code, max(mri.description) as description, max(mri.unit) as unit,
           sum(coalesce(mri.requested_qty,0) - coalesce(mri.received_qty,0)) as remaining
    from material_requests mr
    join material_request_items mri on mri.request_id = mr.id
    where mr.pick_run_no = p_pick_run and mr.factory_code = p_factory and mr.released_at is not null
      and mr.status in ('Open','Partially Received')
    group by mri.item_code
    having sum(coalesce(mri.requested_qty,0) - coalesce(mri.received_qty,0)) > 0
  loop
    v_out_code := null; v_kgpb := null; v_itemid := null;
    -- Labels etc. are made at the factory, not picked from the warehouse.
    if exists (select 1 from items i where i.code = m.item_code and i.supplied_by_factory) then continue; end if;

    v_is_bag := m.item_code ~* '-[0-9]+(\.[0-9]+)?\s*KG\s*/\s*(BAG|CTN|CARTON)$' or coalesce(m.unit,'') ~* 'bag|ctn|carton';

    if v_is_bag then
      -- Already a bag SKU — the request is in bags, use as-is.
      v_out_code := m.item_code; v_out_uom := coalesce(m.unit,'BAG'); v_out_qty := ceil(m.remaining);
    else
      -- Loose kg material → convert to a bag SKU. Prefer the last-used bag size for this
      -- material, else the one with the most stock, else the largest bag.
      select bs.code, bs.kgpb into v_out_code, v_kgpb from (
        select i.code,
               coalesce(i.kg_per_bag,
                 (regexp_match(i.code || ' ' || coalesce(i.description,''), '([0-9]+(?:\.[0-9]+)?)\s*KG\s*/\s*(?:BAG|CTN|CARTON)', 'i'))[1]::numeric) as kgpb,
               (select coalesce(sum(s.quantity),0) from wms_stock s where s.item_code = i.code) as onhand,
               (select max(wol.created_at) from wms_order_lines wol join wms_orders wo on wo.id = wol.order_id
                  where wo.source = 'production' and wol.item_code = i.code) as lastused
        from items i
        where upper(coalesce(i.stock_code,'')) = upper(m.item_code)
      ) bs
      where bs.kgpb is not null and bs.kgpb > 0
      order by bs.lastused desc nulls last, bs.onhand desc, bs.kgpb desc
      limit 1;

      if v_out_code is null then
        -- No bag SKU mapped — put the loose material on the order as-is for manual handling.
        v_out_code := m.item_code; v_out_uom := coalesce(m.unit,'KG'); v_out_qty := m.remaining;
      else
        v_out_uom := 'BAG'; v_out_qty := ceil(m.remaining / v_kgpb);
      end if;
    end if;

    select id into v_itemid from items where code = v_out_code limit 1;
    v_line := v_line + 1;
    insert into wms_order_lines (order_id, line_no, item_id, item_code, description, quantity, qty_picked, uom)
    values (v_oid, v_line, v_itemid, v_out_code, m.description, v_out_qty, 0, v_out_uom);
  end loop;

  return v_oid;
end $$;
grant execute on function public.create_production_order(text, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
