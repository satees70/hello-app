import { AccountType } from "../enums";
import { prisma } from "../prisma";
import { GLInputLine, StatementInputLine } from "../reports";

/** All journal lines for a company, joined with account + entry + property. */
export async function getGeneralLedgerData(companyId: string): Promise<GLInputLine[]> {
  const entries = await prisma.journalEntry.findMany({
    where: { companyId },
    include: { lines: { include: { account: true } }, property: true },
  });
  const out: GLInputLine[] = [];
  for (const e of entries) {
    for (const l of e.lines) {
      out.push({
        accountCode: l.account.code,
        accountName: l.account.name,
        accountType: l.account.type as AccountType,
        date: e.date,
        description: e.description,
        propertyId: e.propertyId,
        propertyName: e.property?.name ?? null,
        debit: l.debit.toString(),
        credit: l.credit.toString(),
      });
    }
  }
  return out;
}

/** AR (account 1100) movements for a lease — charges (debit) and payments (credit). */
export async function getTenantStatementLines(companyId: string, leaseId: string): Promise<StatementInputLine[]> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { companyId, code: "1100" }, entry: { companyId, leaseId } },
    include: { entry: true },
  });
  return lines.map((l) => ({
    date: l.entry.date,
    description: l.entry.description,
    debit: l.debit.toString(),
    credit: l.credit.toString(),
  }));
}
