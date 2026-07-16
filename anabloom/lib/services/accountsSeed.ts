import { Prisma } from "@prisma/client";
import { CHART_OF_ACCOUNTS } from "../accounts";
import { prisma } from "../prisma";

type Tx = Prisma.TransactionClient | typeof prisma;

/** Seed the fixed chart of accounts for a company (idempotent). */
export async function seedChartOfAccounts(companyId: string, db: Tx = prisma) {
  for (const a of CHART_OF_ACCOUNTS) {
    await db.account.upsert({
      where: { companyId_code: { companyId, code: a.code } },
      update: {},
      create: { companyId, code: a.code, name: a.name, type: a.type, isSystem: a.isSystem },
    });
  }
}
