/**
 * PART A — multi-company data migration (safe two-step, idempotent).
 *
 * Upgrades a v6 (single-company) database in place so no existing data is lost:
 *   1. capture each user's currency + every business row's owner (raw reads,
 *      BEFORE any structural change)
 *   2. push a transitional schema that ADDS a nullable companyId to every
 *      business table and creates the Company table (no data loss)
 *   3. create one default Company ("My Company") per user, carrying the user's
 *      currency, and backfill companyId on every row (raw UPDATEs by id)
 *   4. push the final schema (companyId NOT NULL + per-company indexes/uniques)
 *   5. assert row counts are unchanged and nothing is orphaned (0 NULLs)
 *
 * Portable across SQLite (dev) and Postgres (prod): structural changes go
 * through `prisma db push` (dialect-correct), data moves via portable raw SQL.
 *
 * Run against the TARGET database:
 *   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/migrate-multicompany.ts
 */
import { execSync } from "child_process";
import { readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const OWNED_TABLES = [
  "Property",
  "Account",
  "Tenant",
  "Lease",
  "JournalEntry",
  "FixedAsset",
  "LockedPeriod",
  "BankStatement",
];
const ALL_SCOPED = [...OWNED_TABLES, "LeaseDocument", "Attachment"];

const SCHEMA = join(process.cwd(), "prisma", "schema.prisma");
const TMP_SCHEMA = join(process.cwd(), "prisma", "_schema.step1.prisma");

/** Build the transitional schema: companyId (+ its relation) made optional. */
function writeTransitionalSchema() {
  let text = readFileSync(SCHEMA, "utf8");
  // Make the companyId scalar optional (whitespace-agnostic — the schema aligns
  // columns with varying spaces).
  text = text.replace(/companyId(\s+)String\b(?!\?)/g, "companyId$1String?");
  // Make its relation field optional to match.
  text = text.replace(/company(\s+)Company(\s+)@relation\(fields: \[companyId\]/g, "company$1Company?$2@relation(fields: [companyId]");
  writeFileSync(TMP_SCHEMA, text);
}

function push(schema: string) {
  execSync(`npx prisma db push --skip-generate --accept-data-loss --schema "${schema}"`, {
    stdio: "inherit",
    env: process.env,
  });
}

async function count(table: string): Promise<number> {
  const r = (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM "${table}"`)) as { c: number | bigint }[];
  return Number(r[0].c);
}

async function main() {
  // Idempotency: if any Company already exists, assume already migrated.
  try {
    const existing = (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM "Company"`)) as { c: number | bigint }[];
    if (Number(existing[0].c) > 0) {
      console.log("Company table already populated — migration already applied. Nothing to do.");
      return;
    }
  } catch {
    /* Company table doesn't exist yet — fresh v6 DB, proceed. */
  }

  // 1) Capture BEFORE any structural change (userId/currency get dropped later).
  const users = (await prisma.$queryRawUnsafe(`SELECT id, currency FROM "User"`)) as { id: string; currency: string | null }[];
  if (users.length === 0) {
    console.log("No users — nothing to migrate.");
    return;
  }
  const ownerOf: Record<string, { id: string; userId: string }[]> = {};
  for (const t of OWNED_TABLES) {
    ownerOf[t] = (await prisma.$queryRawUnsafe(`SELECT id, "userId" FROM "${t}"`)) as { id: string; userId: string }[];
  }
  const before: Record<string, number> = {};
  for (const t of ALL_SCOPED) before[t] = await count(t);

  console.log("Row counts before:", before);

  // 2) Transitional push: add nullable companyId + Company table.
  writeTransitionalSchema();
  console.log("→ pushing transitional schema (nullable companyId + Company table)…");
  push(TMP_SCHEMA);

  // 3) Create one default Company per user (typed client → correct datetimes,
  //    cross-dialect). Company shape is identical in the transitional & final
  //    schema so the typed client works against the transitional DB state.
  const companyByUser = new Map<string, string>();
  for (const u of users) {
    const c = await prisma.company.create({
      data: { userId: u.id, name: "My Company", currency: u.currency || "RM" },
    });
    companyByUser.set(u.id, c.id);
  }

  // Ids are system-generated cuids (safe alnum) — inline them so the raw SQL is
  // portable across SQLite (?) and Postgres ($n) without placeholder dialects.
  const safe = (s: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error(`Unsafe id: ${s}`);
    return s;
  };

  // Backfill owned tables by id lists per company.
  for (const t of OWNED_TABLES) {
    const byCompany = new Map<string, string[]>();
    for (const row of ownerOf[t]) {
      const cid = companyByUser.get(row.userId);
      if (!cid) continue;
      const arr = byCompany.get(cid) ?? [];
      arr.push(row.id);
      byCompany.set(cid, arr);
    }
    for (const [cid, ids] of byCompany) {
      for (let i = 0; i < ids.length; i += 200) {
        const inList = ids.slice(i, i + 200).map((id) => `'${safe(id)}'`).join(",");
        await prisma.$executeRawUnsafe(`UPDATE "${t}" SET "companyId" = '${safe(cid)}' WHERE id IN (${inList})`);
      }
    }
  }

  // LeaseDocument + Attachment inherit company from their parent.
  await prisma.$executeRawUnsafe(
    `UPDATE "LeaseDocument" SET "companyId" = (SELECT "companyId" FROM "Lease" WHERE "Lease".id = "LeaseDocument"."leaseId")`
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "Attachment" SET "companyId" = (SELECT "companyId" FROM "JournalEntry" WHERE "JournalEntry".id = "Attachment"."journalEntryId")`
  );

  // 4) Final push: enforce NOT NULL + per-company indexes/uniques.
  console.log("→ pushing final schema (companyId NOT NULL)…");
  push(SCHEMA);

  // 5) Assertions.
  const after: Record<string, number> = {};
  for (const t of ALL_SCOPED) after[t] = await count(t);
  console.log("Row counts after :", after);
  for (const t of ALL_SCOPED) {
    if (before[t] !== after[t]) throw new Error(`Row count changed for ${t}: ${before[t]} -> ${after[t]}`);
    const nulls = (await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM "${t}" WHERE "companyId" IS NULL`)) as { c: number | bigint }[];
    if (Number(nulls[0].c) > 0) throw new Error(`${t} has ${nulls[0].c} orphaned rows with NULL companyId`);
  }
  const companies = await count("Company");
  console.log(`✓ Migration complete. Created ${companies} default company(ies); no rows lost, no orphans.`);
}

function cleanup() {
  try {
    rmSync(TMP_SCHEMA, { force: true });
  } catch {
    /* ignore */
  }
}

main()
  .then(() => {
    cleanup();
    return prisma.$disconnect();
  })
  .catch(async (e) => {
    cleanup();
    console.error("MIGRATION FAILED:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
