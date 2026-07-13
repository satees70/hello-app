-- 2026-07 · Warehouse receipt PER LINE (photo per item) + DO GRN
-- ----------------------------------------------------------------------------
-- The warehouse confirms each delivery-order LINE with its own photo (like Goods
-- Received), on a dedicated Warehouse page. When every line of a DO is confirmed,
-- the DO is stamped received. The GRN number stays at the DO level. Warehouse
-- staff (profiles.warehouse_user) and Head Office/admin can do this.
--
-- Run this in the Supabase SQL editor. Safe to re-run. Photos go in the existing
-- `delivery-orders` bucket (same one Goods Received uses).
-- ============================================================================

-- DO-level fields (also in 2026-07-do-warehouse-receipt.sql; repeated so this file
-- is safe to run on its own).
alter table public.dispatch_orders add column if not exists received_at timestamptz;
alter table public.dispatch_orders add column if not exists received_by uuid;
alter table public.dispatch_orders add column if not exists received_by_name text;
alter table public.dispatch_orders add column if not exists warehouse_grn text;

-- Warehouse staff must see every factory's DO (+ its returns) to receive it.
drop policy if exists do_read on public.dispatch_orders;
create policy do_read on public.dispatch_orders for select using (
  my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())
  or coalesce((select warehouse_user from public.profiles where id = auth.uid()), false)
);
drop policy if exists mret_read on public.material_returns;
create policy mret_read on public.material_returns for select using (
  my_factory_code() = 'HEAD_OFFICE' or factory_code = any (my_factory_codes())
  or coalesce((select warehouse_user from public.profiles where id = auth.uid()), false)
);

-- Per-line receipt fields.
alter table public.dispatch_order_lines add column if not exists received_at timestamptz;
alter table public.dispatch_order_lines add column if not exists received_by uuid;
alter table public.dispatch_order_lines add column if not exists received_by_name text;
alter table public.dispatch_order_lines add column if not exists photo_path text;

-- Confirm ONE line (with its photo). Rolls the DO up to "received" once all lines
-- on it are confirmed.
create or replace function public.confirm_do_line(p_line_id uuid, p_photo_path text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_do uuid; v_pending int;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can confirm a delivery line';
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.dispatch_order_lines
     set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name,
         photo_path = coalesce(nullif(p_photo_path, ''), photo_path)
   where id = p_line_id
   returning dispatch_id into v_do;
  if v_do is null then raise exception 'Delivery line not found'; end if;
  select count(*) into v_pending from public.dispatch_order_lines where dispatch_id = v_do and received_at is null;
  if v_pending = 0 then
    update public.dispatch_orders set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name where id = v_do;
  end if;
end $$;
grant execute on function public.confirm_do_line(uuid, text) to authenticated;

-- Undo a line confirmation. The DO is no longer fully received.
create or replace function public.unconfirm_do_line(p_line_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_do uuid;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can change a delivery line';
  end if;
  update public.dispatch_order_lines set received_at = null, received_by = null, received_by_name = null
   where id = p_line_id returning dispatch_id into v_do;
  if v_do is not null then update public.dispatch_orders set received_at = null where id = v_do; end if;
end $$;
grant execute on function public.unconfirm_do_line(uuid) to authenticated;

-- Set the DO's warehouse GRN number (cross-reference), without marking received.
create or replace function public.set_do_grn(p_do_id uuid, p_grn text)
  returns void language plpgsql security definer set search_path = public as $$
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can set the GRN';
  end if;
  update public.dispatch_orders set warehouse_grn = nullif(btrim(p_grn), '') where id = p_do_id;
end $$;
grant execute on function public.set_do_grn(uuid, text) to authenticated;
