-- CORRECTION to the received-on-paper backfill: key it on the DO's ACTUAL date (created_at),
-- not departed_at. The earlier "mark all lorry out" cleanup overwrote departed_at to now()
-- (16 Jul), so filtering by departed_at missed the real backlog. This marks every delivery
-- order CREATED on 14 Jul 2026 or earlier as received on paper (no photos) and rolls it up
-- to received. Idempotent (only unreceived rows), no notifications. Run ONCE in Supabase.

-- 1) Finished-goods lines.
update public.dispatch_order_lines
   set received_at = now(),
       received_by_name = coalesce(received_by_name, 'Received on paper')
 where received_at is null
   and dispatch_id in (
     select id from public.dispatch_orders
     where departed_at is not null
       and created_at < timestamptz '2026-07-15 00:00:00+08');

-- 2) Raw-material returns.
update public.material_returns
   set received_at = now(),
       received_by_name = coalesce(received_by_name, 'Received on paper')
 where received_at is null
   and dispatch_id in (
     select id from public.dispatch_orders
     where departed_at is not null
       and created_at < timestamptz '2026-07-15 00:00:00+08');

-- 3) Roll the DOs up to received.
update public.dispatch_orders
   set received_at = now(),
       received_by_name = coalesce(received_by_name, 'Received on paper')
 where received_at is null
   and departed_at is not null
   and created_at < timestamptz '2026-07-15 00:00:00+08';
