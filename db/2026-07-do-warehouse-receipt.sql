-- 2026-07 · Warehouse receipt of a delivery order (photo + their GRN number)
-- ----------------------------------------------------------------------------
-- After a DO's lorry is out, the warehouse confirms receipt: attaches a photo,
-- enters THEIR system's GRN number (to cross-reference this DO), and marks it
-- received. Warehouse staff (profiles.warehouse_user) and Head Office/admin can do
-- this for any factory. Photo + GRN are optional (never blocks marking received).
--
-- Run this in the Supabase SQL editor. Safe to re-run.
-- NOTE: the photo goes in the existing `delivery-photos` storage bucket — no new
-- bucket needed.
-- ============================================================================

alter table public.dispatch_orders add column if not exists received_at timestamptz;
alter table public.dispatch_orders add column if not exists received_by uuid;
alter table public.dispatch_orders add column if not exists received_by_name text;
alter table public.dispatch_orders add column if not exists warehouse_grn text;
alter table public.dispatch_orders add column if not exists receipt_photo_path text;

-- Warehouse staff must be able to SEE every factory's DO (today they only see
-- their own factory's) so they can receive it.
drop policy if exists do_read on public.dispatch_orders;
create policy do_read on public.dispatch_orders for select using (
  my_factory_code() = 'HEAD_OFFICE'
  or factory_code = any (my_factory_codes())
  or coalesce((select warehouse_user from public.profiles where id = auth.uid()), false)
);
drop policy if exists mret_read on public.material_returns;
create policy mret_read on public.material_returns for select using (
  my_factory_code() = 'HEAD_OFFICE'
  or factory_code = any (my_factory_codes())
  or coalesce((select warehouse_user from public.profiles where id = auth.uid()), false)
);

-- Only warehouse staff or Head Office/admin may confirm receipt.
create or replace function public.confirm_do_received(p_do_id uuid, p_grn text default null, p_photo_path text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can mark a delivery order received';
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.dispatch_orders
     set received_at = coalesce(received_at, now()),   -- keep the first receipt time on later edits
         received_by = auth.uid(),
         received_by_name = v_name,
         warehouse_grn = nullif(btrim(p_grn), ''),
         receipt_photo_path = coalesce(nullif(p_photo_path, ''), receipt_photo_path)
   where id = p_do_id;
  if not found then raise exception 'Delivery order not found'; end if;
end $$;
grant execute on function public.confirm_do_received(uuid, text, text) to authenticated;

-- Undo a receipt (warehouse / HO) — e.g. marked the wrong DO.
create or replace function public.unreceive_do(p_do_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can change a receipt';
  end if;
  update public.dispatch_orders
     set received_at = null, received_by = null, received_by_name = null
   where id = p_do_id;
end $$;
grant execute on function public.unreceive_do(uuid) to authenticated;
