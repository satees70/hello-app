-- Purchase Orders: store the SQL Account GRN number against a PO, so the warehouse receipt
-- cross-references the double-entry made in SQL Accounting. Run in the Supabase SQL editor.
-- Safe to re-run.

alter table public.wms_purchase_orders add column if not exists sql_grn_no text;

create or replace function public.set_po_sql_grn(p_po_id uuid, p_grn text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not has_perm('warehouse','edit') then raise exception 'Not allowed'; end if;
  update public.wms_purchase_orders set sql_grn_no = nullif(btrim(p_grn), '') where id = p_po_id;
end $$;
grant execute on function public.set_po_sql_grn(uuid, text) to authenticated, anon, service_role;

notify pgrst, 'reload schema';
