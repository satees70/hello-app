import { execSync } from "child_process";

// Create/reset the SQLite test database once before the DB-backed tests run.
export default function setup() {
  execSync("npx prisma db push --skip-generate --force-reset", {
    env: { ...process.env, DATABASE_URL: "file:./test.db", DIRECT_URL: "file:./test.db" },
    stdio: "ignore",
  });
}
