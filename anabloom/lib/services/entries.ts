import { Prisma } from "@prisma/client";
import { CASH_CODES } from "../accounts";
import { buildPosting, PostingInput } from "../posting";
import { prisma } from "../prisma";
import { removeEntryFiles } from "./attachments";
import { assertPeriodUnlocked } from "./period";

export interface CreateEntryInput extends PostingInput {
  companyId: string;
  date: Date;
  description: string;
  propertyId?: string | null;
  leaseId?: string | null;
  fixedAssetId?: string | null;
  periodKey?: string | null; // set only for auto-generated recurring invoices
}

type Tx = Prisma.TransactionClient | typeof prisma;

async function resolveAccountIds(companyId: string, codes: string[], db: Tx): Promise<Map<string, string>> {
  const accounts = await db.account.findMany({
    where: { companyId, code: { in: [...new Set(codes)] } },
    select: { id: true, code: true },
  });
  const map = new Map(accounts.map((a) => [a.code, a.id]));
  for (const code of codes) {
    if (!map.has(code)) throw new Error(`Account ${code} not found for company. Seed the chart of accounts.`);
  }
  return map;
}

/**
 * Create a journal entry from a simple-entry transaction, scoped to a company.
 * The posting engine generates balanced lines; period locking + the balance
 * invariant are enforced server-side. Cash lines carry reconciliation columns.
 */
export async function createEntry(input: CreateEntryInput, db: Tx = prisma) {
  await assertPeriodUnlocked(input.companyId, input.date);
  const lines = buildPosting(input); // throws PostingError if invalid/unbalanced
  const idByCode = await resolveAccountIds(input.companyId, lines.map((l) => l.accountCode), db);

  return db.journalEntry.create({
    data: {
      companyId: input.companyId,
      propertyId: input.propertyId ?? null,
      leaseId: input.leaseId ?? null,
      date: input.date,
      description: input.description,
      sourceType: input.sourceType,
      periodKey: input.periodKey ?? null,
      fixedAssetId: input.fixedAssetId ?? null,
      lines: {
        create: lines.map((l) => ({
          accountId: idByCode.get(l.accountCode)!,
          debit: l.debit.toFixed(2),
          credit: l.credit.toFixed(2),
        })),
      },
    },
    include: { lines: { include: { account: true } } },
  });
}

/** Delete an entry. Blocked if its period is locked or any line is reconciled.
 *  Also removes the storage files backing its attachments. */
export async function deleteEntry(companyId: string, entryId: string) {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: entryId, companyId },
    include: { lines: true },
  });
  if (!entry) throw new Error("Entry not found.");
  await assertPeriodUnlocked(companyId, entry.date);
  if (entry.lines.some((l) => l.reconciledAt)) {
    throw new Error("This entry has reconciled bank lines. Un-reconcile the statement first.");
  }
  await removeEntryFiles(entryId); // delete files from storage; rows cascade
  await prisma.journalEntry.delete({ where: { id: entryId } });
}

/** True if any line touches a cash account (1000/1010). */
export function touchesCash(codes: string[]): boolean {
  return codes.some((c) => CASH_CODES.includes(c));
}
