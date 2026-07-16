# Anabloom

Simple **double-entry accounting for property management** (1–10 self-owned
properties). Records plain-language transactions and auto-posts the debit/credit
journal lines under the hood. Includes Trial Balance, P&L and Balance Sheet;
bank reconciliation with PDF/CSV upload and auto-matching; tenants, leases &
arrears with tenancy-agreement document management and expiry alerts; receipt
attachments; recurring rent invoicing with accounting-period locking; and fixed
assets with depreciation.

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
npm run seed                  # demo user + demo data (optional)
npm run dev                   # http://localhost:3000
```

**Demo login:** `demo@example.com` / `demo1234`

Run the tests (posting rules, the three reports, reconciliation engine,
depreciation, AR aging, recurring-invoicing idempotency, locked-period
rejection, renewal deposit carry-forward):

```bash
npm test
```

Type-check and production build:

```bash
npx tsc --noEmit
npm run build
```

### What the seed contains
3 properties, 3 tenants with active leases (one in arrears, one expiring within
60 days, one unstamped so the alerts fire), opening owner capital, a mortgage,
tenant deposits held, one fixed asset with several months of depreciation
posted, ~40 transactions across four months, and a sample July bank statement
(also provided as an importable CSV at `public/sample-july-2026.csv`) with a
couple of lines missing from the books and one book entry missing from the
statement, so the reconciliation workflow can be demonstrated end to end.

---

## 2. Switching SQLite → Supabase (Postgres)

Prisma's `provider` is static, so switch it for production:

1. In `prisma/schema.prisma`, change the datasource provider:
   ```prisma
   datasource db {
     provider  = "postgresql"
     url       = env("DATABASE_URL")   // pooled, port 6543, pgbouncer=true
     directUrl = env("DIRECT_URL")     // direct, port 5432
   }
   ```
2. Point `DATABASE_URL` / `DIRECT_URL` at the Supabase project (see below).
3. Generate the initial Postgres migration and apply it:
   ```bash
   npx prisma migrate dev --name init      # run once against the Supabase DB
   # or, without migration history:
   npx prisma db push
   ```

> Enums are modelled as `String` columns on purpose so the **same schema** works
> on SQLite and Postgres. Money is Prisma `Decimal` throughout (never float).

---

## 3. Production deployment runbook

### 3a. Create the Supabase project (dashboard — only you can do this)
1. Go to https://supabase.com/dashboard → **New project**. Suggested name:
   **`anabloom`**. Choose a region near Malaysia (e.g. Singapore) and set a
   strong database password. **Do not reuse an existing project.**
2. **Project Settings → Database → Connection string:**
   - **Connection pooling** (Transaction mode) → this is your `DATABASE_URL`.
     Ensure it ends with port **6543** and add `?pgbouncer=true&connection_limit=1`.
   - **Direct connection** (port **5432**) → this is your `DIRECT_URL`.
3. **Project Settings → API:** copy the **Project URL** (`SUPABASE_URL`) and the
   **service_role** secret (`SUPABASE_SERVICE_ROLE_KEY`) — server-side only.
4. **Storage → New bucket:** create a **private** bucket named **`receipts`**
   (used for receipts and tenancy documents; served via short-lived signed URLs).
5. Apply the schema and (optionally) seed only the demo user:
   ```bash
   DATABASE_URL="<pooled>" DIRECT_URL="<direct>" npx prisma db push
   # Production starts empty by default. Only seed if you explicitly want demo data:
   # DATABASE_URL="<pooled>" DIRECT_URL="<direct>" npm run seed
   ```

### 3b. Deploy to Vercel
1. Import the repo into Vercel. Set the **Root Directory** to `anabloom`.
2. **Environment variables** (Project → Settings → Environment Variables):
   | Name | Value |
   |---|---|
   | `DATABASE_URL` | Supabase **pooled** string (6543, `pgbouncer=true`) |
   | `DIRECT_URL` | Supabase **direct** string (5432) |
   | `SUPABASE_URL` | Supabase Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role secret |
   | `SUPABASE_STORAGE_BUCKET` | `receipts` |
   | `STORAGE_DRIVER` | `supabase` |
   | `NEXTAUTH_SECRET` | a strong random secret (see below) |
   | `NEXTAUTH_URL` | `https://anabloom.srrieaswari.com` |
   | `CRON_SECRET` | a strong random secret (protects the cron endpoint) |
3. Generate a strong `NEXTAUTH_SECRET`:
   ```bash
   openssl rand -base64 32
   ```
4. The Vercel **Cron** for monthly rent invoicing is already declared in
   `vercel.json` (`/api/cron/invoicing`, 01:00 on the 1st). Vercel picks it up
   automatically on deploy. (Recurring invoices also self-heal via an idempotent
   catch-up on every dashboard load, so no month is ever skipped or doubled.)
5. Deploy.

### 3c. Custom domain
1. Vercel → Project → **Settings → Domains** → add `anabloom.srrieaswari.com`.
2. Vercel shows a target value. At wherever **`srrieaswari.com`** DNS is managed,
   create a **CNAME** record:
   - **Name/Host:** `anabloom`
   - **Value/Target:** the value Vercel shows (typically `cname.vercel-dns.com`)
3. Wait for Vercel to verify the domain and issue the TLS certificate; confirm
   `https://anabloom.srrieaswari.com` loads with a valid certificate.

### 3d. Post-deploy check
1. Register a real account on the live URL.
2. Record one test transaction (e.g. "Rent received").
3. Open **Reports → Trial Balance** and confirm it shows **Balanced ✓**.
4. Delete the test data (Settings → Danger zone → delete all data) if it was a
   throwaway account.

---

## 4. Operations

### Rotate `NEXTAUTH_SECRET`
1. Generate a new secret: `openssl rand -base64 32`.
2. Update `NEXTAUTH_SECRET` in Vercel and redeploy. Existing sessions are
   invalidated (users simply sign in again). Do this if the secret may have
   leaked.

### Back up the Supabase database
- **Automatic:** Supabase takes daily backups (retention depends on your plan) —
  Dashboard → Database → Backups. Point-in-time recovery is available on paid
  plans.
- **Manual dump:**
  ```bash
  pg_dump "<DIRECT_URL>" -Fc -f anabloom-$(date +%F).dump
  # restore:
  pg_restore --clean --if-exists -d "<DIRECT_URL>" anabloom-YYYY-MM-DD.dump
  ```
- Storage bucket contents (receipts/documents) can be exported from the Supabase
  Storage dashboard or via the storage API.

---

## 5. How the accounting works

- **Chart of accounts** is seeded per user with a fixed code structure (1000s
  assets … 5000s expenses). Names are editable; accounts with postings can't be
  deleted.
- **Simple entry, double-entry underneath.** You pick a transaction type (Rent
  received, Expense paid, Loan repayment, …) and the server generates balanced
  debit/credit lines (`lib/posting.ts`). Every entry must satisfy
  `sum(debits) == sum(credits)` with at least two lines — enforced server-side.
- **Reports** (`lib/reports.ts`): Trial Balance (must balance), P&L (income −
  expenses), Balance Sheet (Assets = Liabilities + Equity, with retained
  earnings = all-time net income to date). AR aging buckets outstanding rent
  0–30 / 31–60 / 61–90 / 90+.
- **Period locking** (`lib/services/period.ts`): creating/editing/deleting any
  entry dated in a locked month is rejected. Unlocking requires typing the month.
- **Bank reconciliation** (`lib/reconcile/*`): CSV column-mapping + PDF text
  layout heuristics (Maybank/CIMB/Public Bank/RHB profiles + generic fallback);
  a deterministic matcher with confidence tiers that never auto-confirms when two
  identical amounts collide near the same date; a finish step that stamps and
  locks reconciled cash lines and stores a printable reconciliation report.
- **Depreciation** (`lib/depreciation.ts`): straight-line, prorated partial first
  month, stops exactly at salvage value; the "Run depreciation" action posts one
  journal per asset per month, idempotently.

All money math uses `decimal.js` / Prisma `Decimal`; never floating point.
