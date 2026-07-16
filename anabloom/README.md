# Anabloom

**Multi-company, double-entry accounting for property management.** You record
plain-language transactions; the engine auto-posts balanced debit/credit journal
lines. Each company keeps a fully separate set of books, with a group-level
summary across all of them.

Covers: chart of accounts · ledger + manual journals · properties · tenants,
leases & arrears (tenancy documents, stamping, expiry alerts, renewals) ·
recurring rent invoicing · receipt attachments · **suppliers, bills & accounts
payable** · fixed assets & depreciation · bank reconciliation (PDF/CSV upload +
auto-matching) · accounting-period locks · a full reports suite · and a **group
overview** with consolidated (management-summary) P&L and Balance Sheet.

- **Stack:** Next.js 14 (App Router, TypeScript) · Prisma · NextAuth (email +
  password) · Tailwind · SQLite (dev) / Postgres on Supabase (prod) · Vercel.
- **Production target:** https://anabloom.srrieaswari.com backed by a dedicated
  Supabase project.

---

## 1. Local setup (SQLite)

```bash
cd anabloom
npm install
cp .env.example .env          # defaults are fine for local dev
npx prisma db push            # create the SQLite dev.db from the schema
npm run seed                  # demo user + two companies of demo data (optional)
npm run dev                   # http://localhost:3000
```

**Demo login:** `demo@example.com` / `demo1234` (two companies: *Anabloom
Properties Sdn Bhd* and *Anabloom Ventures Sdn Bhd*).

Run the test suite (82 tests — posting rules, all reports, reconciliation
engine, depreciation, AR/AP aging, recurring idempotency, period locks,
multi-company isolation, group totals, AP invariant, statement ties):

```bash
npm test
```

Type-check + production build:

```bash
npx tsc --noEmit
npm run build
```

---

## 2. Multi-company concepts

- A **User** (login) owns one or more **Companies**. Currency lives on the
  company; the chart of accounts, journal entries, properties, tenants, leases,
  fixed assets, bank statements, suppliers, bills and period locks all belong to
  exactly one company.
- Every page operates on the **active company** (switcher in the header, top
  left). The active company is remembered per session (cookie). Books never mix:
  a query for one company can never return another's rows (enforced centrally in
  `lib/company.ts` and covered by a tenant-isolation test).
- **Group overview** (top nav) aggregates across all your companies: per-company
  cards, a combined 12-month chart, a tagged Attention list, and **Group P&L** /
  **Group Balance Sheet** with one column per company plus a combined total.
  This is a **management summary, not a statutory consolidation** — there are no
  inter-company eliminations; each company files its own accounts.
- **Inter-company transfers:** add an "Inter-company …" receivable (1xxx) in the
  lending company and a matching payable (2xxx) in the borrowing company. The
  Group Balance Sheet flags these balances and checks they net to zero.
- **New users** are routed to `/onboarding` to create their first company.
  Manage companies (add / rename / reg-no / currency), period locks, and
  delete-company-data in **Settings**.

---

## 3. Reports

Every report is scoped to the active company, print-friendly, and CSV-exportable.

| Report | Where | Notes |
|---|---|---|
| **Journal / Ledger** | Ledger | All entries newest-first, expandable to debit/credit lines; filters + CSV. |
| **General Ledger** | Reports | Per account: opening, every posting with running balance, closing. Single- or all-accounts, property filter. Trial Balance rows drill in here. |
| **Trial Balance** | Reports | As-of date; every account with a balance; must balance. |
| **Profit & Loss** | Reports | Date range, per property or consolidated; Summary or month-by-month columns. |
| **Balance Sheet** | Reports | As-of date; Assets = Liabilities + Equity, retained earnings computed. |
| **AR Aging** | Reports | Outstanding rent per tenant, 0–30/31–60/61–90/90+. |
| **Tenant statement** | Tenants → Statement | Per lease: opening owed, charges, payments, running balance, closing; company header; ties to AR aging. |
| **AP Aging** | Reports | Outstanding bills per supplier, bucketed by days overdue. |
| **Supplier statement** | Suppliers → Statement | Per supplier: bills, payments, running balance, closing owed; ties to AP aging. |
| **Deposit Register** | Reports | Tenant deposits held (account 2000), per tenant. |
| **Fixed Asset Register** | Reports / Fixed Assets | Cost, accumulated depreciation, net book value. |
| **Bank reconciliations** | Bank Rec | Past reconciliations with stored reports; reopenable. |
| **Group P&L / Group Balance Sheet** | Group | Columns per company + combined total (management summary). |

---

## 4. Suppliers & accounts payable

- Add **suppliers** with default payment terms. Create **bills** (expense or
  asset purchased on credit) — the posting engine books Dr expense/asset, Cr
  2200 Accounts payable, and the bill's due date defaults to bill date +
  supplier terms. Attach the supplier invoice like any receipt.
- **Record payments** against one or more open bills (partial allowed; one
  payment can cover several bills) — Dr 2200, Cr Cash, with per-bill allocations.
- **Void** an unpaid bill (only if its period is unlocked) to reverse its
  posting. The bank-rec "Create entry" flow can also settle a bill from a
  money-out statement line.
- **Invariant (tested):** the 2200 Accounts payable balance on the Trial Balance
  always equals the sum of unpaid bill balances.

---

## 5. Migrating an existing (single-company) database → multi-company

If you already deployed the pre-multi-company version and have **real data**,
run the safe, idempotent migration **after taking a backup** (below). It adds a
default company per user and backfills every record, asserting nothing is lost.

```bash
# 1) BACK UP FIRST (see §7). Then, against the target database:
DATABASE_URL="<pooled>" DIRECT_URL="<direct>" npx tsx scripts/migrate-multicompany.ts
```

The script: adds a nullable `companyId` everywhere + creates the Company table →
creates one "My Company" per user (carrying their currency) and backfills all
rows → enforces `NOT NULL` + per-company indexes → asserts row counts are
unchanged and there are zero orphans. It is cross-dialect (SQLite/Postgres) and
safe to re-run (it no-ops if a Company already exists). A fresh database created
from the current schema needs no migration — just `prisma db push` + `npm run seed`.

---

## 6. SQLite → Supabase (Postgres) switch & deploy

### 6a. Switch the provider
In `prisma/schema.prisma` change the datasource provider to `postgresql`, then
set `DATABASE_URL` (pooled, port 6543, `pgbouncer=true`) and `DIRECT_URL`
(direct, port 5432) to the dedicated Supabase project. Enums are modelled as
String columns so the same schema targets both engines; money is Prisma Decimal.

### 6b. Supabase (dashboard — only you can do this)
1. https://supabase.com/dashboard → **New project** (suggested name `anabloom`;
   region near Malaysia; strong DB password). **Do not reuse another project.**
2. **Settings → Database → Connection string:** copy the **pooled** (6543,
   append `?pgbouncer=true&connection_limit=1`) → `DATABASE_URL`, and the
   **direct** (5432) → `DIRECT_URL`.
3. **Settings → API:** copy Project URL (`SUPABASE_URL`) and the **service_role**
   secret (`SUPABASE_SERVICE_ROLE_KEY`).
4. **Storage → New bucket:** private bucket **`receipts`**.
5. Apply the schema (fresh) or run the migration (existing data):
   ```bash
   DATABASE_URL="<pooled>" DIRECT_URL="<direct>" npx prisma db push
   # optional demo user: DATABASE_URL=... DIRECT_URL=... npm run seed
   ```

### 6c. Vercel
Import the repo, set **Root Directory** to `anabloom`, and add env vars:
`DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_STORAGE_BUCKET=receipts`, `STORAGE_DRIVER=supabase`,
`NEXTAUTH_SECRET` (`openssl rand -base64 32`),
`NEXTAUTH_URL=https://anabloom.srrieaswari.com`, `CRON_SECRET`. The monthly
rent-invoicing cron is declared in `vercel.json` (runs per company).

### 6d. Custom domain
Add `anabloom.srrieaswari.com` on the Vercel project, then create a **CNAME**
`anabloom` → the value Vercel shows (typically `cname.vercel-dns.com`) at your
DNS host. Wait for verification + HTTPS.

### 6e. Post-deploy check
Register a real account → create your first company → record one transaction →
confirm **Trial Balance** shows *Balanced ✓* → delete the test data.

---

## 7. Operations

**Rotate `NEXTAUTH_SECRET`:** `openssl rand -base64 32`, update it in Vercel,
redeploy (existing sessions sign out).

**Back up Supabase:** automatic daily backups (Dashboard → Database → Backups;
PITR on paid plans). Manual dump:
```bash
pg_dump "<DIRECT_URL>" -Fc -f anabloom-$(date +%F).dump
pg_restore --clean --if-exists -d "<DIRECT_URL>" anabloom-YYYY-MM-DD.dump
```
Export Storage (receipts/documents) from the Supabase Storage dashboard.

---

## 8. How the accounting works

- **Simple entry, double-entry underneath.** You pick a transaction type; the
  server generates balanced lines (`lib/posting.ts`). Every entry must satisfy
  `sum(debits) == sum(credits)` with ≥2 lines — enforced server-side. The engine
  is never bypassed: bills, payments, deposits, depreciation and reconciliation
  all post through it.
- **Period locking** rejects create/edit/delete of any entry in a locked month
  (per company). **Reconciled** cash lines can't be edited until the statement
  is reopened.
- All money uses `decimal.js` / Prisma `Decimal` — never floating point.
