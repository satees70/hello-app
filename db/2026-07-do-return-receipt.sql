-- 2026-07 · Warehouse receipt also covers RAW-MATERIAL RETURN lines
-- ----------------------------------------------------------------------------
-- A delivery order can carry finished-goods lines (dispatch_order_lines) AND/OR
-- raw-material returns (material_returns). The Warehouse page must let the
-- warehouse photo-confirm BOTH. This adds per-line receipt to material_returns,
-- a confirm/undo for a return line, and a shared roll-up so a DO is marked
-- received only when EVERY line (goods + returns) is confirmed.
--
-- Run this in the Supabase SQL editor. Safe to re-run.
-- Depends on db/2026-07-do-line-receipt.sql (dispatch_order_lines receipt + notify).
-- ============================================================================

alter table public.material_returns add column if not exists received_at timestamptz;
alter table public.material_returns add column if not exists received_by uuid;
alter table public.material_returns add column if not exists received_by_name text;
alter table public.material_returns add column if not exists photo_path text;

-- Shared roll-up: when every goods line AND every return on a DO is received,
-- stamp the DO received and notify the sending factory (HO sees all).
create or replace function public._do_receipt_rollup(p_do uuid, p_name text)
  returns void language plpgsql security definer set search_path = public as $$
declare v_pending int;
begin
  select (select count(*) from public.dispatch_order_lines where dispatch_id = p_do and received_at is null)
       + (select count(*) from public.material_returns where dispatch_id = p_do and received_at is null)
    into v_pending;
  if v_pending = 0 then
    update public.dispatch_orders set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = p_name where id = p_do;
    insert into public.notifications (author_id, factory_code, type, title, body, link, ref)
    select auth.uid(), d.factory_code, 'dispatch', '📦 Delivery received at warehouse',
           'Delivery order ' || coalesce(d.do_number, '') || ' fully received'
             || case when nullif(d.warehouse_grn, '') is not null then ' · GRN ' || d.warehouse_grn else '' end
             || ' by ' || coalesce(p_name, 'warehouse') || '.',
           '/dispatch', 'do_received:' || d.id::text
      from public.dispatch_orders d where d.id = p_do
      on conflict (ref) do nothing;
  end if;
end $$;

-- Re-point confirm_do_line at the shared roll-up (goods + returns).
create or replace function public.confirm_do_line(p_line_id uuid, p_photo_path text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_do uuid;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can confirm a delivery line';
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.dispatch_order_lines
     set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name,
         photo_path = coalesce(nullif(p_photo_path, ''), photo_path)
   where id = p_line_id returning dispatch_id into v_do;
  if v_do is null then raise exception 'Delivery line not found'; end if;
  perform public._do_receipt_rollup(v_do, v_name);
end $$;
grant execute on function public.confirm_do_line(uuid, text) to authenticated;

-- Confirm a RETURN line (with its photo).
create or replace function public.confirm_do_return(p_return_id uuid, p_photo_path text default null)
  returns void language plpgsql security definer set search_path = public as $$
declare v_name text; v_do uuid;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can confirm a return';
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  update public.material_returns
     set received_at = coalesce(received_at, now()), received_by = auth.uid(), received_by_name = v_name,
         photo_path = coalesce(nullif(p_photo_path, ''), photo_path)
   where id = p_return_id returning dispatch_id into v_do;
  if v_do is null then raise exception 'Return line not found'; end if;
  perform public._do_receipt_rollup(v_do, v_name);
end $$;
grant execute on function public.confirm_do_return(uuid, text) to authenticated;

-- Undo a return-line confirmation. The DO is no longer fully received.
create or replace function public.unconfirm_do_return(p_return_id uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_do uuid;
begin
  if not (coalesce((select warehouse_user from public.profiles where id = auth.uid()), false) or public.is_ho_or_admin()) then
    raise exception 'Only warehouse staff or Head Office can change a return';
  end if;
  update public.material_returns set received_at = null, received_by = null, received_by_name = null
   where id = p_return_id returning dispatch_id into v_do;
  if v_do is not null then update public.dispatch_orders set received_at = null where id = v_do; end if;
end $$;
grant execute on function public.unconfirm_do_return(uuid) to authenticated;
