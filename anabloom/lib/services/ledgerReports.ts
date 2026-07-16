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

export interface DepositRegisterRow {
  leaseId: string;
  tenantName: string;
  propertyName: string;
  status: string;
  held: number;
}

/** Deposit register: deposits held (account 2000) per lease/tenant. */
export async function getDepositRegister(companyId: string): Promise<DepositRegisterRow[]> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { companyId, code: "2000" }, entry: { leaseId: { not: null } } },
    include: { entry: { include: { lease: { include: { tenant: true, property: true } } } } },
  });
  const byLease = new Map<string, DepositRegisterRow>();
  for (const l of lines) {
    const lease = l.entry.lease;
    if (!lease) continue;
    let row = byLease.get(lease.id);
    if (!row) {
      row = { leaseId: lease.id, tenantName: lease.tenant.name, propertyName: lease.property.name, status: lease.status, held: 0 };
      byLease.set(lease.id, row);
    }
    row.held += Number(l.credit) - Number(l.debit); // credit-normal liability
  }
  return [...byLease.values()].filter((r) => Math.abs(r.held) > 0.005).sort((a, b) => a.tenantName.localeCompare(b.tenantName));
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
