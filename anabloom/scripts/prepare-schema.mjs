// Picks the Prisma datasource provider from DATABASE_URL so the SAME repo builds
// on Vercel (Postgres) and runs locally (SQLite) with no manual schema edits.
//   - postgres:// or postgresql://  -> provider = "postgresql"
//   - file: (or unset)              -> provider = "sqlite"
// Runs before `prisma generate` in the build script. On Vercel the checkout is
// ephemeral, so rewriting the file in place is safe; locally it is a no-op when
// the provider already matches.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, "..", "prisma", "schema.prisma");

const url = process.env.DATABASE_URL || "";
const provider = /^postgres(ql)?:\/\//i.test(url) ? "postgresql" : "sqlite";

const schema = readFileSync(schemaPath, "utf8");
const next = schema.replace(/provider(\s*=\s*)"(?:sqlite|postgresql)"/, `provider$1"${provider}"`);

if (next !== schema) {
  writeFileSync(schemaPath, next);
  console.log(`[prepare-schema] datasource provider set to "${provider}"`);
} else {
  console.log(`[prepare-schema] datasource provider already "${provider}"`);
}
