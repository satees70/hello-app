-- ONE-TIME cleanup: mark every existing delivery order that was never marked "Lorry out"
-- as departed now, to clear the backlog. From now on staff mark each DO as its lorry leaves,
-- so the pending "Lorry out" buttons only show genuinely-waiting deliveries.
--
-- Run this ONCE in the Supabase SQL editor. It only fills a blank departed_at (safe to re-run;
-- already-departed DOs are untouched). It does NOT send the "on the way" notification, since
-- these deliveries already left. Head Office can still press "undo" on any row if one wasn't
-- actually out yet.
--
-- Two options — run ONE of them:

-- (A) Mark ALL not-yet-out delivery orders as out (what was asked — clears everything):
update public.dispatch_orders
   set departed_at = coalesce(departed_at, now())
 where departed_at is null;

-- (B) Safer: only mark those that already have a lorry assigned (leave truly-unassigned ones
--     for staff to handle). To use this instead, comment out (A) above and run this:
-- update public.dispatch_orders
--    set departed_at = coalesce(departed_at, now())
--  where departed_at is null and nullif(btrim(vehicle), '') is not null;
