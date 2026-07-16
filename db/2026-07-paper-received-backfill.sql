-- ONE-TIME cleanup: mark every delivery order SENT on 14 July 2026 or earlier as
-- "received on paper (no photos)" — confirm all their still-unreceived goods lines and
-- raw-material returns, and roll each DO up to received. This clears the old Warehouse
-- Receiving backlog; from now on staff confirm each item (with a photo) as it arrives.
--
-- Run this ONCE in the Supabase SQL editor. It is idempotent: it only touches rows that
-- are not yet received, so re-running does nothing. It does NOT send notifications (these
-- deliveries already arrived). "Received on paper" is recorded as the receiver name.
--
-- Cutoff = anything that departed BEFORE 15 Jul 2026 00:00 Malaysia time (i.e. 14 Jul and
-- earlier). Times are stored with a timezone, so this is exact.

-- 1) Finished-goods lines on those DOs.
update public.dispatch_order_lines
   set received_at = now(),
       received_by_name = coalesce(received_by_name, 'Received on paper')
 where received_at is null
   and dispatch_id in (
     select id from public.dispatch_orders
     where departed_at is not null
       and departed_at < timestamptz '2026-07-15 00:00:00+08');

-- 2) Raw-material returns on those DOs.
update public.material_returns
   set received_at = now(),
       received_by_name = coalesce(received_by_name, 'Received on paper')
 where received_at is null
   and dispatch_id in (
     select id from public.dispatch_orders
     where departed_at is not null
       and departed_at < timestamptz '2026-07-15 00:00:00+08');

-- 3) Roll the DOs up to received (every item on them is now confirmed).
update public.dispatch_orders
   set received_at = now(),
       received_by_name = coalesce(received_by_name, 'Received on paper')
 where received_at is null
   and departed_at is not null
   and departed_at < timestamptz '2026-07-15 00:00:00+08';
