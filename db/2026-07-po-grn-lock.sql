-- Lock the SQL GRN on a Purchase Order once it's saved.
--
-- Warehouse staff can enter the SQL-Account GRN number on a PO. Once saved it must NOT be edited by
-- ordinary staff — only Head Office can change (or clear) it. This is enforced server-side here (the
-- page also locks the field in the UI). Setting a GRN for the first time is still open to any
-- warehouse-edit user; only CHANGING an already-saved one needs Head Office.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create or replace function public.set_po_sql_grn(p_po_id uuid, p_grn text)
  returns void language plpgsql security definer set search_path = public as $$
declare v_existing text;
begin
  if not has_perm('warehouse', 'edit') then raise exception 'Not allowed'; end if;
  select nullif(btrim(sql_grn_no), '') into v_existing from public.wms_purchase_orders where id = p_po_id;
  -- Once saved, it's locked: only Head Office / admin may change or clear it.
  if v_existing is not null
     and v_existing is distinct from nullif(btrim(p_grn), '')
     and not public.is_ho_or_admin() then
    raise exception 'This SQL GRN is already saved — ask Head Office to change it.';
  end if;
  update public.wms_purchase_orders set sql_grn_no = nullif(btrim(p_grn), '') where id = p_po_id;
end $$;
grant execute on function public.set_po_sql_grn(uuid, text) to authenticated;

notify pgrst, 'reload schema';
