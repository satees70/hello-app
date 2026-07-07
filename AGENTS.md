<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# EASWARI operations portal — project guide

A multi-factory operations app for a Malaysian spice/food manufacturer (SRRI EASWARI
MILLS). Covers Sales Orders → Material Requests → Goods Received → Production →
Packing → Dispatch/Delivery, plus HR attendance/OT and a Driver app. Factories use
`AVINA*` codes; "Head Office" (HO) is `factory_code = 'HEAD_OFFICE'`.

**Stack:** Next.js (modified — see above) · Supabase (Postgres, Auth, Storage, RLS) ·
Vercel hosting · Anthropic API (reads Sales/Delivery Order PDFs). Runs as a PWA with
subdomains: `hr.`, `driver.`, `production.` (see `proxy.ts`).

## ⚠️ The most important rule: database changes are NOT automatic
Anything in `db/*.sql` must be **run by hand by the owner in the Supabase SQL editor** —
it does NOT deploy with the code. So:
- **Never assume a schema/trigger/RPC/RLS change is live.** Always give the user the SQL
  and tell them to run it in Supabase.
- Write migrations **idempotent / safe to re-run** (`create or replace`, `if not exists`,
  `drop policy if exists`), name them `db/YYYY-MM-<desc>.sql`, and start with a comment
  explaining why + "Run in the Supabase SQL editor."
- Most features are **two-part**: app code (merge a PR → Vercel auto-deploys) **and** a
  Supabase SQL step. Call out both.

## Auth & permissions (this is where bugs hide)
- Identity is Supabase Auth; the `profiles` row holds `role`, a per-module `permissions`
  grid, `factory_code`/`factory_codes`, `readonly_factories`, `location_perms`,
  `warehouse_user`, `offsite_allowed`.
- Check access with `lib/permissions.ts` → `can(profile, module, action, factoryCode?)`.
  `RESTRICTED_MODULES` (hr, driver, grinding, grinding_recipe) need an explicit grant.
  Admins (`role === 'admin'`) and HO pass most checks.
- **Server API routes run with the Supabase SERVICE ROLE key (they bypass RLS), so they
  MUST authenticate the caller** via `lib/apiAuth.ts` (`requirePerm` / `requireAdmin`,
  which verify the Supabase JWT). Client code must call these routes through
  `lib/api.ts` `apiFetch` so the token is sent. Plain `fetch` is only for open endpoints
  like `/api/whoami`.
- When gating a route, **match the page's own access rule**, not a guess. E.g. Sales Order
  upload needs only `sales` **view**; Goods Received upload needs `goods_received` **edit**
  OR `warehouse_user` OR a per-factory (`location_perms`) grant. Getting this wrong locks
  out real staff (it happened — see the extract routes).
- Database-side, prefer `has_perm()`, `my_factory_code()`, `my_factory_codes()`,
  `is_ho_or_admin()`. **Never add `using (true)`** RLS policies — legacy HR tables were
  deliberately locked down (`db/2026-07-hr-rls-lockdown.sql`).

## How some features work
- **Notifications/push:** DB triggers insert rows into `notifications` (factory-targeted;
  HO sees all; or personal via `user_id`). A per-row push is sent by `/api/push` using the
  row's `title`/`body`. A BEFORE INSERT trigger enriches text with location + who did it.
- **Approvals:** factory users often submit *requests* that HO approves (change requests,
  mr-cancel, lorry/crew approval) via SECURITY DEFINER RPCs; HO/admin edits apply at once.
- **Payroll/attendance is money-sensitive.** OT/lunch/half-day math lives in
  `lib/attendance.ts` + `lib/attendanceReport.ts`. Confirm the intended rule with the owner
  before changing it.

## Before you ship
- `node_modules` isn't committed — run `npm install` first in a fresh session.
- Verify with `npx tsc --noEmit` and a `npx next build` (dummy `NEXT_PUBLIC_SUPABASE_URL`
  etc. are fine). **Pre-existing repo-wide lint errors exist** — only worry about ones in
  files you changed.
- Work on a branch, push, open a PR; the owner merges. Don't assume it's merged/deployed.
- The owner is non-technical: explain what to do in plain steps, and always separate
  "merge the PR" from "run this SQL in Supabase."
