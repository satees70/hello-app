"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCompany } from "@/lib/company";
import { SourceType } from "@/lib/enums";
import { prisma } from "@/lib/prisma";
import {
  autoMatch,
  confirmMatch,
  createEntryForLine,
  finishReconciliation,
  ignoreLine,
  reopenReconciliation,
} from "@/lib/services/reconciliation";

function s(fd: FormData, k: string) {
  return (fd.get(k) as string | null)?.trim() ?? "";
}

export async function autoMatchAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const id = s(fd, "statementId");
  await autoMatch(companyId, id);
  revalidatePath(`/reconciliation/${id}`);
}

export async function confirmMatchAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await confirmMatch(companyId, s(fd, "statementLineId"), s(fd, "journalLineId"));
  revalidatePath(`/reconciliation/${s(fd, "statementId")}`);
}

export async function ignoreLineAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await ignoreLine(companyId, s(fd, "statementLineId"));
  revalidatePath(`/reconciliation/${s(fd, "statementId")}`);
}

export async function createEntryForLineAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await createEntryForLine(companyId, s(fd, "statementLineId"), {
    sourceType: s(fd, "sourceType") as SourceType,
    propertyId: s(fd, "propertyId") || undefined,
    accountCode: s(fd, "accountCode") || undefined,
  });
  revalidatePath(`/reconciliation/${s(fd, "statementId")}`);
  revalidatePath("/ledger");
}

export async function finishReconciliationAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const id = s(fd, "statementId");
  await finishReconciliation(companyId, id);
  revalidatePath(`/reconciliation/${id}`);
  revalidatePath("/ledger");
}

export async function reopenReconciliationAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const id = s(fd, "statementId");
  await reopenReconciliation(companyId, id);
  revalidatePath(`/reconciliation/${id}`);
}

export async function deleteStatementAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const id = s(fd, "statementId");
  const statement = await prisma.bankStatement.findFirst({ where: { id, companyId }, include: { lines: true } });
  if (!statement) throw new Error("Not found");
  const ids = statement.lines.map((l) => l.matchedJournalLineId).filter((x): x is string => !!x);
  for (const jid of ids) await prisma.journalLine.updateMany({ where: { id: jid }, data: { reconciledAt: null, statementLineId: null } });
  await prisma.bankStatement.delete({ where: { id } });
  redirect("/reconciliation");
}
