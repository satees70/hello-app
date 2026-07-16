"use server";

import { compare, hash } from "bcryptjs";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUserId } from "@/lib/auth";
import { ACTIVE_COMPANY_COOKIE, assertCompanyOwnership, requireCompany } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { SourceType } from "@/lib/enums";
import { saveEntryAttachments } from "@/lib/services/attachments";
import { seedChartOfAccounts } from "@/lib/services/accountsSeed";
import { createBill, payBills, voidBill } from "@/lib/services/payables";
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

// ---------------- Companies ----------------
export async function createCompanyAction(fd: FormData) {
  const userId = await requireUserId();
  const company = await prisma.company.create({
    data: {
      userId,
      name: s(fd, "name") || "New Company",
      registrationNo: s(fd, "registrationNo") || null,
      currency: s(fd, "currency") || "RM",
    },
  });
  await seedChartOfAccounts(company.id);
  cookies().set(ACTIVE_COMPANY_COOKIE, company.id, { path: "/", httpOnly: true, sameSite: "lax" });
  redirect("/");
}

export async function updateCompanyAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "id");
  await assertCompanyOwnership(userId, id);
  await prisma.company.update({
    where: { id },
    data: {
      name: s(fd, "name"),
      registrationNo: s(fd, "registrationNo") || null,
      currency: s(fd, "currency") || "RM",
    },
  });
  revalidatePath("/", "layout");
  revalidatePath("/settings");
}

export async function setActiveCompanyAction(fd: FormData) {
  const userId = await requireUserId();
  const id = s(fd, "id");
  await assertCompanyOwnership(userId, id);
  cookies().set(ACTIVE_COMPANY_COOKIE, id, { path: "/", httpOnly: true, sameSite: "lax" });
  redirect("/");
}

// ---------------- Entries ----------------
export async function createEntryAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const sourceType = s(fd, "sourceType") as SourceType;
  const date = optDate(fd, "date") ?? new Date();
  const leaseId = s(fd, "leaseId") || null;
  let propertyId = s(fd, "propertyId") || null;

  if (leaseId) {
    const lease = await prisma.lease.findFirst({ where: { id: leaseId, companyId } });
    if (lease) propertyId = lease.propertyId;
  }

  const base = {
    companyId,
    date,
    description: s(fd, "description") || "Entry",
    propertyId,
    leaseId,
    sourceType,
    cashAccountCode: s(fd, "cashAccountCode") || undefined,
  };

  // "Expense on credit" now requires a supplier and creates a Bill alongside
  // its journal entry (posting engine unchanged: Dr 5xxx, Cr 2200).
  if (sourceType === "EXPENSE_ON_CREDIT") {
    const supplierId = s(fd, "supplierId");
    if (!supplierId) throw new Error("Choose a supplier — a credit purchase creates a bill.");
    const bill = await createBill({
      companyId,
      supplierId,
      propertyId,
      billDate: date,
      dueDate: optDate(fd, "dueDate"),
      reference: s(fd, "reference") || null,
      description: base.description,
      amount: num(fd, "amount"),
      kind: "expense",
      accountCode: s(fd, "expenseAccountCode"),
    });
    const files = fd.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length && bill.journalEntryId) await saveEntryAttachments(companyId, bill.journalEntryId, files);
    revalidatePath("/bills");
    revalidatePath("/ledger");
    revalidatePath("/");
    return;
  }

  let input: Parameters<typeof createEntry>[0];
  switch (sourceType) {
    case "OTHER_INCOME_RECEIVED":
      input = { ...base, amount: num(fd, "amount"), incomeAccountCode: s(fd, "incomeAccountCode") };
      break;
    case "EXPENSE_PAID":
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

  const entry = await createEntry(input);
  const files = fd.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length) await saveEntryAttachments(companyId, entry.id, files);

  revalidatePath("/ledger");
  revalidatePath("/");
}

export async function deleteEntryAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await deleteEntry(companyId, s(fd, "id"));
  revalidatePath("/ledger");
  revalidatePath("/");
}

export async function deleteAttachmentAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const attId = s(fd, "id");
  const entryId = s(fd, "entryId");
  const att = await prisma.attachment.findFirst({ where: { id: attId, companyId, entry: { id: entryId } } });
  if (!att) throw new Error("Attachment not found.");
  await getStorage().remove(att.storagePath);
  await prisma.attachment.delete({ where: { id: attId } });
  revalidatePath(`/ledger/${entryId}`);
}

// ---------------- Properties ----------------
export async function createPropertyAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await prisma.property.create({
    data: {
      companyId,
      name: s(fd, "name"),
      address: s(fd, "address") || null,
      monthlyRent: num(fd, "monthlyRent"),
      notes: s(fd, "notes") || null,
    },
  });
  revalidatePath("/properties");
}

export async function updatePropertyAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const id = s(fd, "id");
  await prisma.property.updateMany({
    where: { id, companyId },
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
  const { companyId } = await requireCompany();
  const id = s(fd, "id");
  const count = await prisma.journalEntry.count({ where: { companyId, propertyId: id } });
  if (count > 0) throw new Error("Property has transactions and cannot be deleted.");
  await prisma.lease.deleteMany({ where: { companyId, propertyId: id } });
  await prisma.property.deleteMany({ where: { id, companyId } });
  revalidatePath("/properties");
}

// ---------------- Tenants & Leases ----------------
export async function createTenantAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await prisma.tenant.create({
    data: {
      companyId,
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
  const { companyId } = await requireCompany();
  const propertyId = s(fd, "propertyId");
  const tenantId = s(fd, "tenantId");
  // ensure both belong to the company
  const [prop, ten] = await Promise.all([
    prisma.property.findFirst({ where: { id: propertyId, companyId } }),
    prisma.tenant.findFirst({ where: { id: tenantId, companyId } }),
  ]);
  if (!prop || !ten) throw new Error("Property or tenant not in this company.");
  await prisma.lease.create({
    data: {
      companyId,
      propertyId,
      tenantId,
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
  const { companyId } = await requireCompany();
  const id = s(fd, "id");
  const lease = await prisma.lease.findFirst({ where: { id, companyId } });
  if (lease) await prisma.lease.updateMany({ where: { id, companyId }, data: { autoInvoice: !lease.autoInvoice } });
  revalidatePath("/tenants");
}

export async function recordRentPaymentAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const leaseId = s(fd, "leaseId");
  const lease = await prisma.lease.findFirst({ where: { id: leaseId, companyId } });
  if (!lease) throw new Error("Lease not found.");
  await createEntry({
    companyId,
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
  const { companyId } = await requireCompany();
  await prisma.lease.updateMany({
    where: { id: s(fd, "id"), companyId },
    data: { stampedDate: optDate(fd, "stampedDate") },
  });
  revalidatePath("/tenants");
}

export async function renewLeaseAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await renewLease({
    companyId,
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
  const { companyId } = await requireCompany();
  await endLease({
    companyId,
    leaseId: s(fd, "leaseId"),
    endDate: optDate(fd, "endDate") ?? new Date(),
    deposit: (s(fd, "deposit") as DepositDisposition) || "none",
  });
  revalidatePath("/tenants");
  revalidatePath("/ledger");
}

// ---------------- Fixed assets ----------------
export async function createAssetAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const asset = await prisma.fixedAsset.create({
    data: {
      companyId,
      name: s(fd, "name"),
      propertyId: s(fd, "propertyId") || null,
      cost: num(fd, "cost"),
      purchaseDate: optDate(fd, "purchaseDate") ?? new Date(),
      usefulLifeMonths: Number(s(fd, "usefulLifeMonths") || "60"),
      salvageValue: num(fd, "salvageValue"),
      assetAccountCode: s(fd, "assetAccountCode") || "1510",
    },
  });
  if (fd.get("postPurchase") === "on") {
    await createEntry({
      companyId,
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
  const { companyId } = await requireCompany();
  const upTo = s(fd, "upTo") || yearMonth(new Date());
  await runDepreciation(companyId, upTo);
  revalidatePath("/assets");
  revalidatePath("/ledger");
}

export async function disposeAssetAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const id = s(fd, "id");
  const asset = await prisma.fixedAsset.findFirst({ where: { id, companyId } });
  if (!asset) throw new Error("Asset not found.");
  const disposalDate = optDate(fd, "date") ?? new Date();
  const proceeds = num(fd, "proceeds");

  const depEntries = await prisma.journalEntry.findMany({
    where: { companyId, fixedAssetId: id, sourceType: "DEPRECIATION" },
    include: { lines: { include: { account: true } } },
  });
  let accumulated = 0;
  for (const e of depEntries)
    for (const l of e.lines) if (l.account.code === "1590") accumulated += Number(l.credit);

  await createEntry({
    companyId,
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
  const { companyId } = await requireCompany();
  await prisma.account.create({
    data: { companyId, code: s(fd, "code"), name: s(fd, "name"), type: s(fd, "type"), isSystem: false },
  });
  revalidatePath("/accounts");
}

export async function renameAccountAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await prisma.account.updateMany({ where: { id: s(fd, "id"), companyId }, data: { name: s(fd, "name") } });
  revalidatePath("/accounts");
}

export async function deactivateAccountAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const id = s(fd, "id");
  const postings = await prisma.journalLine.count({ where: { accountId: id, account: { companyId } } });
  if (postings > 0) throw new Error("Account has postings and cannot be deactivated.");
  await prisma.account.updateMany({ where: { id, companyId, isSystem: false }, data: { active: false } });
  revalidatePath("/accounts");
}

// ---------------- Settings ----------------
export async function lockPeriodAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const ym = s(fd, "yearMonth");
  await prisma.lockedPeriod.upsert({
    where: { companyId_yearMonth: { companyId, yearMonth: ym } },
    update: {},
    create: { companyId, yearMonth: ym },
  });
  revalidatePath("/settings");
}

export async function unlockPeriodAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const ym = s(fd, "yearMonth");
  if (s(fd, "confirm") !== ym) throw new Error("Type the month to confirm unlocking.");
  await prisma.lockedPeriod.deleteMany({ where: { companyId, yearMonth: ym } });
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

// ---------------- Suppliers & bills (PART C) ----------------
export async function createSupplierAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await prisma.supplier.create({
    data: {
      companyId,
      name: s(fd, "name"),
      registrationNo: s(fd, "registrationNo") || null,
      phone: s(fd, "phone") || null,
      email: s(fd, "email") || null,
      defaultTermsDays: Number(s(fd, "defaultTermsDays") || "30"),
      notes: s(fd, "notes") || null,
    },
  });
  revalidatePath("/suppliers");
}

export async function updateSupplierAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await prisma.supplier.updateMany({
    where: { id: s(fd, "id"), companyId },
    data: {
      name: s(fd, "name"),
      registrationNo: s(fd, "registrationNo") || null,
      phone: s(fd, "phone") || null,
      email: s(fd, "email") || null,
      defaultTermsDays: Number(s(fd, "defaultTermsDays") || "30"),
      notes: s(fd, "notes") || null,
    },
  });
  revalidatePath("/suppliers");
}

export async function createBillAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const kind = (s(fd, "kind") as "expense" | "asset") || "expense";
  const bill = await createBill({
    companyId,
    supplierId: s(fd, "supplierId"),
    propertyId: s(fd, "propertyId") || null,
    billDate: optDate(fd, "billDate") ?? new Date(),
    dueDate: optDate(fd, "dueDate"),
    reference: s(fd, "reference") || null,
    description: s(fd, "description") || "Bill",
    amount: num(fd, "amount"),
    kind,
    accountCode: s(fd, "accountCode") || (kind === "asset" ? "1520" : "5900"),
  });
  const files = fd.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length && bill.journalEntryId) await saveEntryAttachments(companyId, bill.journalEntryId, files);
  revalidatePath("/bills");
  revalidatePath("/suppliers");
  revalidatePath("/ledger");
}

export async function payBillsAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const billIds = fd.getAll("billId") as string[];
  const amounts = fd.getAll("payAmount") as string[];
  const allocations = billIds.map((billId, i) => ({ billId, amount: amounts[i] || "0" }));
  await payBills({
    companyId,
    supplierId: s(fd, "supplierId"),
    date: optDate(fd, "date") ?? new Date(),
    cashAccountCode: s(fd, "cashAccountCode") || undefined,
    allocations,
  });
  revalidatePath("/bills");
  revalidatePath("/suppliers");
  revalidatePath("/ledger");
}

export async function voidBillAction(fd: FormData) {
  const { companyId } = await requireCompany();
  await voidBill(companyId, s(fd, "id"));
  revalidatePath("/bills");
  revalidatePath("/suppliers");
  revalidatePath("/ledger");
}

export async function deleteCompanyDataAction(fd: FormData) {
  const { companyId } = await requireCompany();
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error("Company not found.");
  if (s(fd, "confirm") !== company.name) throw new Error("Type the company name to confirm.");
  // delete business data but keep the company + its chart of accounts.
  // Bills/payments reference journal entries, so remove them first.
  await prisma.billPayment.deleteMany({ where: { bill: { companyId } } });
  await prisma.bill.deleteMany({ where: { companyId } });
  await prisma.supplier.deleteMany({ where: { companyId } });
  await prisma.journalEntry.deleteMany({ where: { companyId } });
  await prisma.lease.deleteMany({ where: { companyId } });
  await prisma.tenant.deleteMany({ where: { companyId } });
  await prisma.property.deleteMany({ where: { companyId } });
  await prisma.fixedAsset.deleteMany({ where: { companyId } });
  await prisma.bankStatement.deleteMany({ where: { companyId } });
  await prisma.lockedPeriod.deleteMany({ where: { companyId } });
  revalidatePath("/", "layout");
}
