-- Production order creation now takes the CONFIRMED lines from the office (after they
-- cross-check the kg→bag conversion on screen), instead of converting silently. The
-- app proposes the conversion; a person confirms/adjusts it; then this creates the order
-- from exactly those lines.
--
-- Run in the Supabase SQL editor. Safe to re-run. (Requires db/2026-07-production-order.sql.)

drop function if exists public.create_production_order(text, text);

-- p_lines = [{ item_code, description, quantity, uom, item_id? }]
create or replace function public.create_production_order(p_pick_run text, p_factory text, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_oid uuid; v_name text; v_facname text; v_line int := 0;
  el jsonb; v_code text; v_itemid uuid; v_qty numeric; v_uom text;
begin
  if not (is_ho_or_admin() or has_perm('warehouse','edit')) then raise exception 'Not allowed to create a production order'; end if;

  -- Idempotent: one live order per run+factory.
  select id into v_oid from wms_orders
    where source = 'production' and pick_run = p_pick_run and factory_code = p_factory and status <> 'Cancelled'
    limit 1;
  if v_oid is not null then return v_oid; end if;

  select full_name into v_name from profiles where id = auth.uid();
  select name into v_facname from factories where code = p_factory;

  insert into wms_orders (warehouse_code, source, order_no, customer_name, status, factory_code, pick_run, uploaded_by, uploaded_by_name)
  values ('8BT', 'production', p_pick_run, 'Production — ' || coalesce(v_facname, p_factory), 'Review', p_factory, p_pick_run, auth.uid(), v_name)
  returning id into v_oid;

  for el in select jsonb_array_elements(p_lines) loop
    v_code := el->>'item_code';
    v_qty  := (el->>'quantity')::numeric;
    v_uom  := el->>'uom';
    if v_code is null or v_qty is null or v_qty <= 0 then continue; end if;
    v_itemid := nullif(el->>'item_id','')::uuid;
    if v_itemid is null then select id into v_itemid from items where code = v_code limit 1; end if;
    v_line := v_line + 1;
    insert into wms_order_lines (order_id, line_no, item_id, item_code, description, quantity, qty_picked, uom)
    values (v_oid, v_line, v_itemid, v_code, el->>'description', v_qty, 0, coalesce(v_uom,'BAG'));
  end loop;

  return v_oid;
end $$;
grant execute on function public.create_production_order(text, text, jsonb) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
