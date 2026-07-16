"use server";

import { compare, hash } from "bcryptjs";
import { revalidatePath } from "next/cache";
import { requireUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SourceType } from "@/lib/enums";
import { createEntry, deleteEntry } from "@/lib/services/entries";
import { runDepreciation } from "@/lib/services/depreciation";
import { endLease, renewLease, DepositDisposition } from "@/lib/services/leases";
import { yearMonth } from "@/lib/services/period";

function s(fd: FormData, k: string): string {
  return (fd.get(k) as string | null)?.trim() ?? "";
}
function num(fd: FormData, k: string): string {
  const v = s(fd, k);
  return v === "" ? "0" : v;
}
function optDate(fd: FormData, k: string): Date | null {
  const v = s(fd, k);
  return v ? new Date(v + "T00:00:00Z") : null;
}

// ---------------- Entries ----------------
export async function createEntryAction(fd: FormData) {
  const userId = await requireUserId();
  const sourceType = s(fd, "sourceType") as SourceType;
  const date = optDate(fd, "date") ?? new Date();
  const leaseId = s(fd, "leaseId") || null;
  let propertyId = s(fd, "propertyId") || null;

  if (leaseId) {
    const lease = await prisma.lease.findFirst({ where: { id: leaseId, userId } });
    if (lease) propertyId = lease.propertyId;
  }

  const base = {
    userId,
    date,
    description: s(fd, "description") || "Entry",
    propertyId,
    leaseId,
    sourceType,
    cashAccountCode: s(fd, "cashAccountCode") || undefined,
  };

  let input: Parameters<typeof createEntry>[0];
  switch (sourceType) {
    case "OTHER_INCOME_RECEIVED":
      input = { ...base, amount: num(fd, "amount"), incomeAccountCode: s(fd, "incomeAccountCode") };
      break;
    case "EXPENSE_PAID":
    case "EXPENSE_ON_CREDIT":
      input = { ...base, amount: num(fd, "amount"), expenseAccountCode: s(fd, "expenseAccountCode") };
      break;
    case "LOAN_REPAYMENT":
      input = { ...base, principal: num(fd, "principal"), interest: num(fd, "interest") };
      break;
    case "ASSET_PURCHASED":
      input = {
        ...base,
        amount: num(fd, "amount"),
        assetAccountCode: s(fd, "assetAccountCode") || "1500",
        fundingAccountCode: s(fd, "fundingAccountCode") || undefined,
      };
      break;
    case "MANUAL": {
      const codes = fd.getAll("lineCode") as string[];
      const debits = fd.getAll("lineDebit") as string[];
      const credits = fd.getAll("lineCredit") as string[];
      const manualLines = codes
        .map((code, i) => ({ accountCode: code, debit: debits[i] || "0", credit: credits[i] || "0" }))
        .filter((l) => l.accountCode && (Number(l.debit) || Number(l.credit)));
      input = { ...base, manualLines };
      break;
    }
    default:
      input = { ...base, amount: num(fd, "amount") };
  }

  await createEntry(input);
  revalidatePath("/ledger");
  revalidatePath("/");
}

export async function deleteEntryAction(fd: FormData) {
  const userId = await requireUserId();
  await deleteEntry(userId, s(fd, "id"));
  revalidatePath("/ledger");
  revalidatePath("/");
}

// ---------------- Properties ----------------
export async function createPropertyAction(fd: FormData) {
  const userId = await requireUserId();
  await prisma.property.create({
    data: {
      userId,
      name: s(fd, "name"),
      address: s(fd, "address") || null,
      monthlyRent: num(fd, "monthlyRent"),
      notes: s(fd, "notes") || null,
    },
  });
  revalidatePath("/properties");
}

export async function updatePropertyAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "id");
  await prisma.property.updateMany({
    where: { id, userId },
    data: {
      name: s(fd, "name"),
      address: s(fd, "address") || null,
      monthlyRent: num(fd, "monthlyRent"),
      notes: s(fd, "notes") || null,
    },
  });
  revalidatePath("/properties");
}

export async function deletePropertyAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "id");
  const count = await prisma.journalEntry.count({ where: { userId, propertyId: id } });
  if (count > 0) throw new Error("Property has transactions and cannot be deleted.");
  await prisma.lease.deleteMany({ where: { userId, propertyId: id } });
  await prisma.property.deleteMany({ where: { id, userId } });
  revalidatePath("/properties");
}

// ---------------- Tenants & Leases ----------------
export async function createTenantAction(fd: FormData) {
  const userId = await requireUserId();
  await prisma.tenant.create({
    data: {
      userId,
      name: s(fd, "name"),
      phone: s(fd, "phone") || null,
      email: s(fd, "email") || null,
      idNumber: s(fd, "idNumber") || null,
      notes: s(fd, "notes") || null,
    },
  });
  revalidatePath("/tenants");
}

export async function createLeaseAction(fd: FormData) {
  const userId = await requireUserId();
  await prisma.lease.create({
    data: {
      userId,
      propertyId: s(fd, "propertyId"),
      tenantId: s(fd, "tenantId"),
      startDate: optDate(fd, "startDate") ?? new Date(),
      endDate: optDate(fd, "endDate"),
      monthlyRent: num(fd, "monthlyRent"),
      dueDay: Math.min(Math.max(Number(s(fd, "dueDay") || "1"), 1), 28),
      depositAmount: num(fd, "depositAmount"),
      signedDate: optDate(fd, "signedDate"),
      stampedDate: optDate(fd, "stampedDate"),
      noticePeriodDays: s(fd, "noticePeriodDays") ? Number(s(fd, "noticePeriodDays")) : null,
      autoInvoice: fd.get("autoInvoice") === "on",
    },
  });
  revalidatePath("/tenants");
}

export async function toggleAutoInvoiceAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "id");
  const lease = await prisma.lease.findFirst({ where: { id, userId } });
  if (lease) await prisma.lease.updateMany({ where: { id, userId }, data: { autoInvoice: !lease.autoInvoice } });
  revalidatePath("/tenants");
}

export async function recordRentPaymentAction(fd: FormData) {
  const userId = await requireUserId();
  const leaseId = s(fd, "leaseId");
  const lease = await prisma.lease.findFirst({ where: { id: leaseId, userId } });
  if (!lease) throw new Error("Lease not found.");
  // Pay against receivable if there is outstanding AR for this lease, else plain rent received.
  await createEntry({
    userId,
    leaseId,
    propertyId: lease.propertyId,
    date: optDate(fd, "date") ?? new Date(),
    description: s(fd, "description") || "Rent payment",
    sourceType: (s(fd, "sourceType") as SourceType) || "RENT_PAYMENT",
    amount: num(fd, "amount") === "0" ? lease.monthlyRent.toString() : num(fd, "amount"),
  });
  revalidatePath("/tenants");
  revalidatePath("/ledger");
}

export async function setStampedDateAction(fd: FormData) {
  const userId = await requireUserId();
  await prisma.lease.updateMany({
    where: { id: s(fd, "id"), userId },
    data: { stampedDate: optDate(fd, "stampedDate") },
  });
  revalidatePath("/tenants");
}

export async function renewLeaseAction(fd: FormData) {
  const userId = await requireUserId();
  await renewLease({
    userId,
    leaseId: s(fd, "leaseId"),
    startDate: optDate(fd, "startDate") ?? new Date(),
    endDate: optDate(fd, "endDate"),
    monthlyRent: num(fd, "monthlyRent"),
    dueDay: s(fd, "dueDay") ? Number(s(fd, "dueDay")) : undefined,
    signedDate: optDate(fd, "signedDate"),
    stampedDate: optDate(fd, "stampedDate"),
  });
  revalidatePath("/tenants");
}

export async function endLeaseAction(fd: FormData) {
  const userId = await requireUserId();
  await endLease({
    userId,
    leaseId: s(fd, "leaseId"),
    endDate: optDate(fd, "endDate") ?? new Date(),
    deposit: (s(fd, "deposit") as DepositDisposition) || "none",
  });
  revalidatePath("/tenants");
  revalidatePath("/ledger");
}

// ---------------- Fixed assets ----------------
export async function createAssetAction(fd: FormData) {
  const userId = await requireUserId();
  const asset = await prisma.fixedAsset.create({
    data: {
      userId,
      name: s(fd, "name"),
      propertyId: s(fd, "propertyId") || null,
      cost: num(fd, "cost"),
      purchaseDate: optDate(fd, "purchaseDate") ?? new Date(),
      usefulLifeMonths: Number(s(fd, "usefulLifeMonths") || "60"),
      salvageValue: num(fd, "salvageValue"),
      assetAccountCode: s(fd, "assetAccountCode") || "1510",
    },
  });
  // Optionally post the purchase entry
  if (fd.get("postPurchase") === "on") {
    await createEntry({
      userId,
      propertyId: asset.propertyId,
      fixedAssetId: asset.id,
      date: asset.purchaseDate,
      description: `Asset purchased — ${asset.name}`,
      sourceType: "ASSET_PURCHASED",
      amount: asset.cost.toString(),
      assetAccountCode: asset.assetAccountCode,
      fundingAccountCode: s(fd, "fundingAccountCode") || "1000",
    });
  }
  revalidatePath("/assets");
  revalidatePath("/ledger");
}

export async function runDepreciationAction(fd: FormData) {
  const userId = await requireUserId();
  const upTo = s(fd, "upTo") || yearMonth(new Date());
  await runDepreciation(userId, upTo);
  revalidatePath("/assets");
  revalidatePath("/ledger");
}

export async function disposeAssetAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "id");
  const asset = await prisma.fixedAsset.findFirst({ where: { id, userId } });
  if (!asset) throw new Error("Asset not found.");
  const disposalDate = optDate(fd, "date") ?? new Date();
  const proceeds = num(fd, "proceeds");

  // accumulated depreciation posted for this asset (credits to 1590)
  const depEntries = await prisma.journalEntry.findMany({
    where: { userId, fixedAssetId: id, sourceType: "DEPRECIATION" },
    include: { lines: { include: { account: true } } },
  });
  let accumulated = 0;
  for (const e of depEntries)
    for (const l of e.lines) if (l.account.code === "1590") accumulated += Number(l.credit);

  await createEntry({
    userId,
    propertyId: asset.propertyId,
    fixedAssetId: id,
    date: disposalDate,
    description: `Asset disposal — ${asset.name}`,
    sourceType: "ASSET_DISPOSAL",
    assetAccountCode: asset.assetAccountCode,
    disposal: { cost: asset.cost.toString(), accumulated: accumulated.toFixed(2), proceeds },
  });
  await prisma.fixedAsset.update({ where: { id }, data: { disposedAt: disposalDate } });
  revalidatePath("/assets");
  revalidatePath("/ledger");
}

// ---------------- Chart of accounts ----------------
export async function addAccountAction(fd: FormData) {
  const userId = await requireUserId();
  const code = s(fd, "code");
  const type = s(fd, "type");
  await prisma.account.create({
    data: { userId, code, name: s(fd, "name"), type, isSystem: false },
  });
  revalidatePath("/accounts");
}

export async function renameAccountAction(fd: FormData) {
  const userId = await requireUserId();
  await prisma.account.updateMany({ where: { id: s(fd, "id"), userId }, data: { name: s(fd, "name") } });
  revalidatePath("/accounts");
}

export async function deactivateAccountAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "id");
  const postings = await prisma.journalLine.count({ where: { accountId: id, account: { userId } } });
  if (postings > 0) throw new Error("Account has postings and cannot be deactivated.");
  await prisma.account.updateMany({ where: { id, userId, isSystem: false }, data: { active: false } });
  revalidatePath("/accounts");
}

// ---------------- Settings ----------------
export async function lockPeriodAction(fd: FormData) {
  const userId = await requireUserId();
  const ym = s(fd, "yearMonth");
  await prisma.lockedPeriod.upsert({
    where: { userId_yearMonth: { userId, yearMonth: ym } },
    update: {},
    create: { userId, yearMonth: ym },
  });
  revalidatePath("/settings");
}

export async function unlockPeriodAction(fd: FormData) {
  const userId = await requireUserId();
  const ym = s(fd, "yearMonth");
  if (s(fd, "confirm") !== ym) throw new Error("Type the month to confirm unlocking.");
  await prisma.lockedPeriod.deleteMany({ where: { userId, yearMonth: ym } });
  revalidatePath("/settings");
}

export async function changePasswordAction(fd: FormData) {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("User not found.");
  if (!(await compare(s(fd, "current"), user.passwordHash))) throw new Error("Current password is incorrect.");
  const next = s(fd, "next");
  if (next.length < 6) throw new Error("New password must be at least 6 characters.");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hash(next, 10) } });
  revalidatePath("/settings");
}

export async function setCurrencyAction(fd: FormData) {
  const userId = await requireUserId();
  await prisma.user.update({ where: { id: userId }, data: { currency: s(fd, "currency") || "RM" } });
  revalidatePath("/settings");
}

export async function deleteAllDataAction(fd: FormData) {
  const userId = await requireUserId();
  if (s(fd, "confirm") !== "DELETE") throw new Error('Type DELETE to confirm.');
  await prisma.journalEntry.deleteMany({ where: { userId } });
  await prisma.lease.deleteMany({ where: { userId } });
  await prisma.tenant.deleteMany({ where: { userId } });
  await prisma.property.deleteMany({ where: { userId } });
  await prisma.fixedAsset.deleteMany({ where: { userId } });
  await prisma.bankStatement.deleteMany({ where: { userId } });
  await prisma.lockedPeriod.deleteMany({ where: { userId } });
  revalidatePath("/");
}
