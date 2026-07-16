import { CASH_CODES } from "../accounts";
import { SourceType } from "../enums";
import { money } from "../money";
import { prisma } from "../prisma";
import {
  buildReconciliationReport,
  canFinishReconciliation,
  CashLineInput,
  matchStatement,
  StmtLineInput,
} from "../reconcile/matching";
import { ParsedStatement } from "../reconcile/types";
import { createEntry } from "./entries";
import { getCashLines } from "./ledger";

/** Persist a parsed statement as a DRAFT with its lines, scoped to a company. */
export async function createStatement(companyId: string, fileName: string, parsed: ParsedStatement) {
  const lines = parsed.lines;
  const opening = parsed.openingBalance ? money(parsed.openingBalance) : money(0);
  const closing = parsed.closingBalance
    ? money(parsed.closingBalance)
    : lines.reduce((s, l) => s.plus(money(l.amount)), opening);

  return prisma.bankStatement.create({
    data: {
      companyId,
      fileName,
      bankName: parsed.bankName ?? null,
      accountLabel: parsed.accountLabel ?? null,
      periodStart: parsed.periodStart ? new Date(parsed.periodStart) : new Date(),
      periodEnd: parsed.periodEnd ? new Date(parsed.periodEnd) : new Date(),
      openingBalance: opening.toFixed(2),
      closingBalance: closing.toFixed(2),
      status: "DRAFT",
      lines: {
        create: lines.map((l, i) => ({
          date: new Date(l.date),
          description: l.description,
          amount: money(l.amount).toFixed(2),
          runningBalance: l.runningBalance ? money(l.runningBalance).toFixed(2) : null,
          sortOrder: i,
        })),
      },
    },
  });
}

/** Run the deterministic matcher; persist AUTO_MATCHED suggestions + confidence. */
export async function autoMatch(companyId: string, statementId: string) {
  const statement = await prisma.bankStatement.findFirst({
    where: { id: statementId, companyId },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!statement) throw new Error("Statement not found.");

  const cash = await getCashLines(companyId, true);
  const cashInputs: CashLineInput[] = cash.map((c) => ({ id: c.id, date: c.date, description: c.description, amount: c.amount }));
  const stmtInputs: StmtLineInput[] = statement.lines
    .filter((l) => l.matchStatus === "UNMATCHED" || l.matchStatus === "AUTO_MATCHED")
    .map((l) => ({ id: l.id, date: l.date, description: l.description, amount: l.amount }));

  const results = matchStatement(stmtInputs, cashInputs);
  for (const r of results) {
    await prisma.statementLine.update({
      where: { id: r.statementLineId },
      data: {
        matchStatus: r.matchStatus,
        matchedJournalLineId: r.matchedJournalLineId ?? null,
        matchConfidence: r.matchConfidence ?? null,
      },
    });
  }
  await prisma.bankStatement.update({ where: { id: statementId }, data: { status: "REVIEWED" } });
  return results;
}

export async function confirmMatch(companyId: string, statementLineId: string, journalLineId: string) {
  const line = await prisma.statementLine.findFirst({ where: { id: statementLineId, statement: { companyId } } });
  if (!line) throw new Error("Line not found.");
  await prisma.statementLine.update({
    where: { id: statementLineId },
    data: { matchStatus: "CONFIRMED", matchedJournalLineId: journalLineId },
  });
}

export async function ignoreLine(companyId: string, statementLineId: string) {
  const line = await prisma.statementLine.findFirst({ where: { id: statementLineId, statement: { companyId } } });
  if (!line) throw new Error("Line not found.");
  await prisma.statementLine.update({
    where: { id: statementLineId },
    data: { matchStatus: "IGNORED", matchedJournalLineId: null },
  });
}

/** Create a book entry for an unmatched statement line, then link it. */
export async function createEntryForLine(
  companyId: string,
  statementLineId: string,
  opts: { sourceType: SourceType; propertyId?: string; accountCode?: string; supplierId?: string; billId?: string }
) {
  const line = await prisma.statementLine.findFirst({ where: { id: statementLineId, statement: { companyId } } });
  if (!line) throw new Error("Line not found.");
  const amount = money(line.amount);
  const abs = amount.abs().toFixed(2);

  const entry = await createEntry({
    companyId,
    propertyId: opts.propertyId ?? null,
    date: line.date,
    description: line.description,
    sourceType: opts.sourceType,
    amount: abs,
    incomeAccountCode: opts.sourceType === "OTHER_INCOME_RECEIVED" ? opts.accountCode : undefined,
    expenseAccountCode: opts.sourceType === "EXPENSE_PAID" || opts.sourceType === "EXPENSE_ON_CREDIT" ? opts.accountCode : undefined,
  });
  const cashLine = entry.lines.find((l) => CASH_CODES.includes(l.account.code));
  await prisma.statementLine.update({
    where: { id: statementLineId },
    data: { matchStatus: "ENTRY_CREATED", matchedJournalLineId: cashLine?.id ?? null },
  });
  return entry;
}

/** Finish: verify, stamp reconciledAt on matched cash lines, store report, lock. */
export async function finishReconciliation(companyId: string, statementId: string) {
  const statement = await prisma.bankStatement.findFirst({
    where: { id: statementId, companyId },
    include: { lines: true },
  });
  if (!statement) throw new Error("Statement not found.");

  const check = canFinishReconciliation(
    statement.openingBalance,
    statement.closingBalance,
    statement.lines.map((l) => ({ amount: l.amount, matchStatus: l.matchStatus as never }))
  );
  if (!check.canFinish) {
    if (!check.allResolved) throw new Error("Every statement line must be confirmed, entry-created, or ignored first.");
    throw new Error(`Statement does not reconcile: difference ${check.continuity.difference.toFixed(2)}.`);
  }

  const matchedLineIds = statement.lines.map((l) => l.matchedJournalLineId).filter((x): x is string => !!x);
  const allCash = await getCashLines(companyId, false);
  const clearedIds = new Set(matchedLineIds);
  const outstanding = allCash
    .filter((c) => !clearedIds.has(c.id) && !c.reconciledAt)
    .filter((c) => c.date >= statement.periodStart && c.date <= statement.periodEnd)
    .map((c) => ({ id: c.id, date: c.date, description: c.description, amount: c.amount.toFixed(2) }));

  const report = buildReconciliationReport(
    statement.openingBalance,
    statement.closingBalance,
    statement.lines.map((l) => ({ amount: l.amount, matchStatus: l.matchStatus as never })),
    outstanding.map((o) => ({ id: o.id, date: new Date(o.date), description: o.description, amount: o.amount }))
  );

  await prisma.$transaction(async (tx) => {
    for (const id of matchedLineIds) {
      await tx.journalLine.update({
        where: { id },
        data: { reconciledAt: new Date(), statementLineId: statement.lines.find((l) => l.matchedJournalLineId === id)?.id ?? null },
      });
    }
    await tx.bankStatement.update({
      where: { id: statementId },
      data: { status: "RECONCILED", reconciledAt: new Date(), reportJson: JSON.stringify(report) },
    });
  });
  return report;
}

/** Reopen a reconciled statement: un-reconcile its cash lines. */
export async function reopenReconciliation(companyId: string, statementId: string) {
  const statement = await prisma.bankStatement.findFirst({ where: { id: statementId, companyId }, include: { lines: true } });
  if (!statement) throw new Error("Statement not found.");
  const ids = statement.lines.map((l) => l.matchedJournalLineId).filter((x): x is string => !!x);
  await prisma.$transaction(async (tx) => {
    for (const id of ids) await tx.journalLine.update({ where: { id }, data: { reconciledAt: null, statementLineId: null } });
    await tx.bankStatement.update({ where: { id: statementId }, data: { status: "REVIEWED", reconciledAt: null, reportJson: null } });
  });
}
