import { AccountType } from "../enums";
import { money } from "../money";
import { prisma } from "../prisma";
import { LedgerLine } from "../reports";

/** All journal lines for a company, flattened + joined with account/entry data. */
export async function getLedgerLines(companyId: string): Promise<LedgerLine[]> {
  const entries = await prisma.journalEntry.findMany({
    where: { companyId },
    include: { lines: { include: { account: true } } },
  });
  const lines: LedgerLine[] = [];
  for (const e of entries) {
    for (const l of e.lines) {
      lines.push({
        accountCode: l.account.code,
        accountName: l.account.name,
        accountType: l.account.type as AccountType,
        debit: money(l.debit.toString()),
        credit: money(l.credit.toString()),
        date: e.date,
        propertyId: e.propertyId,
      });
    }
  }
  return lines;
}

export interface CashLineRow {
  id: string;
  date: Date;
  description: string;
  amount: import("decimal.js").default; // signed debit - credit
  reconciledAt: Date | null;
}

/** Unreconciled cash journal lines (accounts 1000/1010) for a company. */
export async function getCashLines(companyId: string, onlyUnreconciled = true): Promise<CashLineRow[]> {
  const lines = await prisma.journalLine.findMany({
    where: {
      account: { companyId, code: { in: ["1000", "1010"] } },
      ...(onlyUnreconciled ? { reconciledAt: null } : {}),
    },
    include: { entry: true },
  });
  return lines.map((l) => ({
    id: l.id,
    date: l.entry.date,
    description: l.entry.description,
    amount: money(l.debit.toString()).minus(money(l.credit.toString())),
    reconciledAt: l.reconciledAt,
  }));
}
