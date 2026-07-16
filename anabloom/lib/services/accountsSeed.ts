import { Prisma } from "@prisma/client";
import { CHART_OF_ACCOUNTS } from "../accounts";
import { prisma } from "../prisma";

type Tx = Prisma.TransactionClient | typeof prisma;

/** Seed the fixed chart of accounts for a new user (idempotent). */
export async function seedChartOfAccounts(userId: string, db: Tx = prisma) {
  for (const a of CHART_OF_ACCOUNTS) {
    await db.account.upsert({
      where: { userId_code: { userId, code: a.code } },
      update: {},
      create: { userId, code: a.code, name: a.name, type: a.type, isSystem: a.isSystem },
    });
  }
}
