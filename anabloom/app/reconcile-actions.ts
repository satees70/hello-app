"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUserId } from "@/lib/auth";
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
  const userId = await requireUserId();
  const id = s(fd, "statementId");
  await autoMatch(userId, id);
  revalidatePath(`/reconciliation/${id}`);
}

export async function confirmMatchAction(fd: FormData) {
  const userId = await requireUserId();
  await confirmMatch(userId, s(fd, "statementLineId"), s(fd, "journalLineId"));
  revalidatePath(`/reconciliation/${s(fd, "statementId")}`);
}

export async function ignoreLineAction(fd: FormData) {
  const userId = await requireUserId();
  await ignoreLine(userId, s(fd, "statementLineId"));
  revalidatePath(`/reconciliation/${s(fd, "statementId")}`);
}

export async function createEntryForLineAction(fd: FormData) {
  const userId = await requireUserId();
  await createEntryForLine(userId, s(fd, "statementLineId"), {
    sourceType: s(fd, "sourceType") as SourceType,
    propertyId: s(fd, "propertyId") || undefined,
    accountCode: s(fd, "accountCode") || undefined,
  });
  revalidatePath(`/reconciliation/${s(fd, "statementId")}`);
  revalidatePath("/ledger");
}

export async function finishReconciliationAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "statementId");
  await finishReconciliation(userId, id);
  revalidatePath(`/reconciliation/${id}`);
  revalidatePath("/ledger");
}

export async function reopenReconciliationAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "statementId");
  await reopenReconciliation(userId, id);
  revalidatePath(`/reconciliation/${id}`);
}

export async function deleteStatementAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "statementId");
  const statement = await prisma.bankStatement.findFirst({ where: { id, userId }, include: { lines: true } });
  if (!statement) throw new Error("Not found");
  // un-reconcile any linked lines first
  const ids = statement.lines.map((l) => l.matchedJournalLineId).filter((x): x is string => !!x);
  for (const jid of ids) await prisma.journalLine.updateMany({ where: { id: jid }, data: { reconciledAt: null, statementLineId: null } });
  await prisma.bankStatement.delete({ where: { id } });
  redirect("/reconciliation");
}
