# Production readiness review — production.srrieaswari.com

**Date:** 2026-07-04
**Scope:** Code-level review of the `hello-app` Next.js portal (HR / attendance, driver,
sales & production modules) as deployed to `production.srrieaswari.com`,
`hr.srrieaswari.com` and `driver.srrieaswari.com`.
**Method:** Static review of the repository. No changes were made to the live site and
no endpoints were exercised against production.

> **Headline:** The app is **not safe to expose publicly in its current state.** Several
> server API routes use the Supabase **service-role key** (which bypasses all database
> security) with **no authentication at all**. An anonymous person on the internet can
> create an admin account, reset any user's password, and read or alter payroll and
> attendance data. These should be treated as launch blockers.

---

## Severity summary

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| C1 | 🔴 Critical | Unauthenticated **admin account creation** | `app/api/create-user/route.ts` |
| C2 | 🔴 Critical | Unauthenticated **password reset / role escalation** for any user | `app/api/update-user/route.ts` |
| C3 | 🔴 Critical | ~18 attendance/driver routes write payroll & delivery data with the service-role key and **no auth** | `app/api/attendance/*`, `app/api/driver/*` |
| C4 | 🔴 Critical | `requireAdmin` is **dead code** and, even if used, is bypassable with a header | `lib/auth.ts` |
| H1 | 🟠 High | Legacy HR tables have **wide-open RLS** (`using (true)`), readable/writable with the public anon key | `db/easwari-schema.sql` |
| H2 | 🟠 High | AI extraction routes unauthenticated → **Anthropic cost abuse** + import tampering | `app/api/extract-*/route.ts` |
| M1 | 🟡 Medium | All authorization is **client-side only** | `components/AuthGate.tsx`, `hooks/useRequireView.ts` |
| M2 | 🟡 Medium | Network allowlist has **no server enforcement**; `whoami` trusts spoofable header | `app/api/whoami/route.ts`, `app/admin/allowed-networks` |
| M3 | 🟡 Medium | No security headers / CSP | `next.config.ts` |
| M4 | 🟡 Medium | No rate limiting on any route | (all) |
| L1 | ⚪ Low | README is unmodified `create-next-app` boilerplate | `README.md` |
| L2 | ⚪ Low | `update-user` accepts privileged fields (`role`, `permissions`) unvalidated from the client | `app/api/update-user/route.ts` |

---

## Critical findings (launch blockers)

### C1 — Anyone can create an admin account
`app/api/create-user/route.ts` builds a client with `SUPABASE_SERVICE_ROLE_KEY` and, on
`POST`, calls `supabaseAdmin.auth.admin.createUser(...)` then inserts a `profiles` row —
including `role` and `permissions` taken **straight from the request body**. There is no
authentication or authorization check anywhere in the handler.

**Impact:** An anonymous caller can `POST /api/create-user` with `role: "admin"` and mint
themselves a fully privileged account, then log in through the normal UI.

### C2 — Anyone can reset any user's password or escalate any account
`app/api/update-user/route.ts` (same service-role client, no auth) accepts an arbitrary
`id` plus `password`, `role`, `permissions`, `capabilities`, etc. It will happily:
- set a new password for **any** user id (`updateUserById(id, { password })`), and
- overwrite that user's `role`/`permissions`.

**Impact:** Full account takeover of any existing user (including the real admin) by an
unauthenticated caller who knows or guesses a profile id.

### C3 — Payroll, attendance and driver data are writable without auth
Every route below instantiates a service-role Supabase client and performs reads/writes
with **no caller verification**:

```
app/api/attendance/leave          app/api/attendance/review
app/api/attendance/day-flag       app/api/attendance/ot-month
app/api/attendance/deduct-override app/api/attendance/excuse-late
app/api/attendance/holidays       app/api/attendance/shift-profiles
app/api/attendance/outstation     app/api/attendance/sync
app/api/attendance/driver-trip    app/api/attendance/employees
app/api/attendance/employees/sync app/api/attendance/employees/refresh-active
app/api/driver/deliver            app/api/driver/odometer
```

**Impact:** Anyone can alter leave records, overtime, deductions, employee master data,
and mark deliveries delivered/undelivered — directly affecting payroll. The code even
acknowledges this in comments (`TODO(auth): gate by the authenticated driver once real
Supabase Auth lands`).

### C4 — The only auth helper is dead and bypassable
`lib/auth.ts` `requireAdmin()` returns "allowed" if the request carries header
`x-admin: 1` or if `ALLOW_ALL=1`. Its own comment says *"replace ALL of this with real
Supabase Auth + role checks before launch."* A repo-wide search shows **no route imports
or calls it** — so nothing is protected, and even where it might be added later, a
client-supplied header trivially defeats it.

**The correct pattern already exists in this codebase:** `app/api/push/diag/route.ts`
verifies the caller by reading the `Authorization: Bearer <token>` header and calling
`admin.auth.getUser(token)`. That approach should be applied to every service-role route.

---

## High findings

### H1 — Legacy HR tables have wide-open Row Level Security
`db/easwari-schema.sql` enables RLS on the HR tables (`employees`, `attendance_punches`,
`attendance_reviews`, `shift_profiles`, `leave_days`, …) but every policy is
`for select using (true)` / `for all using (true) with check (true)`. Because the anon
key is shipped to the browser (`NEXT_PUBLIC_SUPABASE_ANON_KEY`), **anyone with that public
key can read and write all HR/payroll data directly against Supabase**, without going
through the app at all.

Note the *newer* tables in `db/migrations.sql` are done correctly — they use
`my_factory_code()`, `has_perm(...)`, `auth.uid()` predicates. The gap is specifically the
older HR schema.

### H2 — Unauthenticated AI extraction routes
`app/api/extract-sales-order` and `app/api/extract-delivery-order` are unauthenticated and
call the Anthropic API (`ANTHROPIC_API_KEY`) on each request, with `maxDuration = 60`.
An attacker can loop these to (a) run up Anthropic spend and (b) delete/insert
`sales_order_lines` / `sales_imports` rows via the `importId` they supply.

---

## Medium findings

- **M1 — Authorization is client-side only.** `AuthGate`, `useRequireView` and `can()` run
  in the browser and only hide UI. With open RLS (H1) and unauthenticated routes (C1–C3),
  they provide no real enforcement.
- **M2 — Network allowlisting is cosmetic.** `allowed_networks` is managed client-side and
  `app/api/whoami` derives the client IP from `x-forwarded-for` (first entry, spoofable).
  No server middleware enforces the allowlist, so "offsite" restrictions can be bypassed.
- **M3 — No security headers.** `next.config.ts` is empty. Add HSTS, `X-Content-Type-Options`,
  `X-Frame-Options`/frame-ancestors, and a Content-Security-Policy.
- **M4 — No rate limiting.** None of the routes throttle, amplifying C1–C3 and H2.

## Low findings

- **L1** — `README.md` is the default `create-next-app` text; replace with real run/deploy
  and environment-variable docs.
- **L2** — Even once auth is added, `update-user`/`create-user` accept `role` and
  `permissions` verbatim from the client; validate these server-side and restrict who may
  set `role: 'admin'`.

---

## Recommended remediation order

1. **Gate every service-role route** behind a real server-side check (verify the Supabase
   JWT via `auth.getUser(token)` as `push/diag` already does, then check role/permission
   for the action). Until then, consider taking the write routes offline.
2. **Fix RLS on the legacy HR tables** (H1): replace `using (true)` with real predicates,
   matching the pattern in `migrations.sql`.
3. **Lock down create/update-user** to authenticated admins and validate privileged fields
   (C1, C2, L2).
4. **Authenticate the extract routes** and add basic rate limiting (H2, M4).
5. **Enforce the network allowlist server-side**, or drop the feature so it isn't relied on
   (M2).
6. Add **security headers** in `next.config.ts` (M3), then clean up docs (L1) and remove the
   dead `requireAdmin` placeholder (C4).

---

## What looks good

- No secrets are committed; `.env*` is git-ignored and no keys appear in tracked files.
- The push send route (`app/api/push`) is correctly gated by a shared `PUSH_SECRET`.
- `push/diag` demonstrates the right server-side Supabase-JWT verification pattern.
- Newer tables in `migrations.sql` use proper, factory-scoped RLS with `has_perm()`.
- `fetchAll()` correctly pages past Supabase's 1000-row limit.

*This review is based on the repository state at the current HEAD of
`claude/production-review-mkbj3h`. Findings C1–C3 and H1 were confirmed from source but not
exploited against the live environment; validate in a staging environment before and after
remediation.*
