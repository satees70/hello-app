-- Per-user WMS-area permissions: Head Office can now allow / restrict each part of the warehouse
-- app for a user (Inbound, Stock, Picking, Counts & approvals, Reports) — same as the production
-- app's permission grid. The single 'warehouse' permission stays as the MASTER (lets someone into
-- the WMS at all); the five wms_* areas narrow which parts they use.
--
-- This backfill seeds each configured user's new area permissions from their existing 'warehouse'
-- grant, so NOBODY loses access when this ships — a user who had WMS keeps all areas, and Head
-- Office then unticks any area they want to restrict. Only fills users that don't have the keys yet.
--
-- No schema change (permissions live in profiles.permissions jsonb). Run in the Supabase SQL editor.
-- Safe to re-run.

update public.profiles p
set permissions = p.permissions || jsonb_build_object(
  'wms_inbound', coalesce(p.permissions->'warehouse', '{"view":false,"edit":false,"delete":false}'::jsonb),
  'wms_stock',   coalesce(p.permissions->'warehouse', '{"view":false,"edit":false,"delete":false}'::jsonb),
  'wms_picking', coalesce(p.permissions->'warehouse', '{"view":false,"edit":false,"delete":false}'::jsonb),
  'wms_control', coalesce(p.permissions->'warehouse', '{"view":false,"edit":false,"delete":false}'::jsonb),
  'wms_reports', coalesce(p.permissions->'warehouse', '{"view":false,"edit":false,"delete":false}'::jsonb)
)
where p.permissions is not null
  and p.permissions <> '{}'::jsonb
  and not (p.permissions ? 'wms_inbound');

-- (No PostgREST reload needed — this only updates data, not schema.)
