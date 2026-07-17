-- Tighten over-broad RLS reads so a logged-in user can't read data across the whole company.
-- Each change drops + recreates a NAMED policy, so it's reversible and safe to re-run. Writes are
-- left untouched (they already go through the app's permission checks / service-role routes).
--
-- ⚠️ TEST AFTER RUNNING: sign in as a NORMAL (non-admin) staff account and confirm they can still
--    see what they should. Revert snippet is at the bottom if anything is over-tight.
-- Run in the Supabase SQL editor.

-- 1) Notifications — you only see your OWN (tagged) notifications, or your factory's; HO sees all.
--    (Matches exactly who /api/push already sends each notification to. Insert left as-is so the
--     existing in-app "notify" still works.)
drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated using (
  user_id = auth.uid()
  or my_factory_code() = 'HEAD_OFFICE'
  or factory_code = any (my_factory_codes())
);

-- 2) Delivery-order lines — match the parent delivery order's own access (factory / warehouse / HO),
--    the same rule dispatch_orders already uses.
drop policy if exists dol_read on public.dispatch_order_lines;
create policy dol_read on public.dispatch_order_lines for select to authenticated using (
  exists (
    select 1 from public.dispatch_orders d
    where d.id = dispatch_order_lines.dispatch_id
      and (
        my_factory_code() = 'HEAD_OFFICE'
        or d.factory_code = any (my_factory_codes())
        or coalesce((select warehouse_user from public.profiles where id = auth.uid()), false)
      )
  )
);

-- 3) Sales data — only users with the Sales module 'view' permission (admins/HO pass via has_perm).
drop policy if exists sol_all_view on public.sales_order_lines;
create policy sol_all_view on public.sales_order_lines for select to authenticated using (has_perm('sales', 'view'));
drop policy if exists si_all_view on public.sales_imports;
create policy si_all_view on public.sales_imports for select to authenticated using (has_perm('sales', 'view'));

notify pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- NOT changed here (needs your decision): supplier_orders / supplier_order_items are
-- `for all using(true)` — any logged-in user can READ and MODIFY all supplier orders. There is no
-- dedicated permission module for them yet. Tell me who should have access (e.g. HO only, or a new
-- 'purchasing' grant) and I'll scope them. Meanwhile, if you want HO-only immediately, uncomment:
--
-- drop policy if exists supplier_orders_all on public.supplier_orders;
-- create policy supplier_orders_all on public.supplier_orders for all to authenticated
--   using (is_ho_or_admin()) with check (is_ho_or_admin());
-- drop policy if exists supplier_order_items_all on public.supplier_order_items;
-- create policy supplier_order_items_all on public.supplier_order_items for all to authenticated
--   using (is_ho_or_admin()) with check (is_ho_or_admin());

-- ────────────────────────────────────────────────────────────────────────────
-- REVERT (only if a change locked someone out):
-- drop policy if exists notifications_read on public.notifications;
-- create policy notifications_read on public.notifications for select to authenticated using (true);
-- drop policy if exists dol_read on public.dispatch_order_lines;
-- create policy dol_read on public.dispatch_order_lines for select using (true);
-- drop policy if exists sol_all_view on public.sales_order_lines;
-- create policy sol_all_view on public.sales_order_lines for select to authenticated using (true);
-- drop policy if exists si_all_view on public.sales_imports;
-- create policy si_all_view on public.sales_imports for select to authenticated using (true);
