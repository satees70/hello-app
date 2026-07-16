import { ApBill, StatementInputLine } from "../reports";
import { prisma } from "../prisma";
import { createEntry } from "./entries";
import { assertPeriodUnlocked } from "./period";

// ---------- Create a bill (expense or asset purchased on credit) ----------
export interface CreateBillInput {
  companyId: string;
  supplierId: string;
  propertyId?: string | null;
  billDate: Date;
  dueDate?: Date | null;
  reference?: string | null;
  description: string;
  amount: string;
  kind: "expense" | "asset"; // expense -> Dr 5xxx; asset -> Dr 15xx
  accountCode: string; // 5xxx expense account, or 15xx asset account
}

export async function createBill(input: CreateBillInput) {
  const supplier = await prisma.supplier.findFirst({ where: { id: input.supplierId, companyId: input.companyId } });
  if (!supplier) throw new Error("Supplier not found.");
  if (Number(input.amount) <= 0) throw new Error("Bill amount must be greater than zero.");

  const dueDate =
    input.dueDate ?? new Date(input.billDate.getTime() + supplier.defaultTermsDays * 24 * 60 * 60 * 1000);

  // Post the journal entry (Cr 2200 Accounts payable). The engine is unchanged.
  const entry =
    input.kind === "asset"
      ? await createEntry({
          companyId: input.companyId,
          propertyId: input.propertyId ?? null,
          date: input.billDate,
          description: input.description,
          sourceType: "ASSET_PURCHASED",
          amount: input.amount,
          assetAccountCode: input.accountCode,
          fundingAccountCode: "2200",
        })
      : await createEntry({
          companyId: input.companyId,
          propertyId: input.propertyId ?? null,
          date: input.billDate,
          description: input.description,
          sourceType: "EXPENSE_ON_CREDIT",
          amount: input.amount,
          expenseAccountCode: input.accountCode,
        });

  return prisma.bill.create({
    data: {
      companyId: input.companyId,
      supplierId: input.supplierId,
      propertyId: input.propertyId ?? null,
      billDate: input.billDate,
      dueDate,
      reference: input.reference ?? null,
      description: input.description,
      amount: input.amount,
      status: "OPEN",
      journalEntryId: entry.id,
    },
  });
}

// ---------- Pay one or more bills (partial allowed, one entry) ----------
export interface PayBillsInput {
  companyId: string;
  supplierId: string;
  date: Date;
  cashAccountCode?: string;
  allocations: { billId: string; amount: string }[];
}

export async function payBills(input: PayBillsInput) {
  const allocs = input.allocations.filter((a) => Number(a.amount) > 0);
  if (allocs.length === 0) throw new Error("Enter at least one payment amount.");

  const bills = await prisma.bill.findMany({
    where: { id: { in: allocs.map((a) => a.billId) }, companyId: input.companyId, supplierId: input.supplierId },
    include: { payments: true },
  });
  const byId = new Map(bills.map((b) => [b.id, b]));

  // Validate BEFORE posting: each allocation must not exceed the bill's balance.
  let total = 0;
  for (const a of allocs) {
    const bill = byId.get(a.billId);
    if (!bill) throw new Error("Bill not found for this supplier.");
    if (bill.status === "VOID" || bill.status === "PAID") throw new Error(`Bill "${bill.description}" is not open.`);
    const paid = bill.payments.reduce((s, p) => s + Number(p.amount), 0);
    const balance = Number(bill.amount) - paid;
    if (Number(a.amount) > balance + 0.005) throw new Error(`Payment exceeds the balance on "${bill.description}".`);
    total += Number(a.amount);
  }

  // One journal entry for the whole payment: Dr 2200 total, Cr cash total.
  const entry = await createEntry({
    companyId: input.companyId,
    date: input.date,
    description: `Supplier payment (${allocs.length} bill${allocs.length > 1 ? "s" : ""})`,
    sourceType: "PAY_BILL",
    amount: total.toFixed(2),
    cashAccountCode: input.cashAccountCode,
  });

  for (const a of allocs) {
    const bill = byId.get(a.billId)!;
    await prisma.billPayment.create({
      data: { billId: bill.id, journalEntryId: entry.id, date: input.date, amount: a.amount },
    });
    const paid = bill.payments.reduce((s, p) => s + Number(p.amount), 0) + Number(a.amount);
    const status = paid >= Number(bill.amount) - 0.005 ? "PAID" : "PARTIALLY_PAID";
    await prisma.bill.update({ where: { id: bill.id }, data: { status } });
  }
  return entry;
}

// ---------- Void a bill (only if unpaid + period unlocked) ----------
export async function voidBill(companyId: string, billId: string) {
  const bill = await prisma.bill.findFirst({ where: { id: billId, companyId }, include: { payments: true, entry: true } });
  if (!bill) throw new Error("Bill not found.");
  if (bill.status === "VOID") return;
  if (bill.payments.length > 0) throw new Error("This bill has payments and cannot be voided. Reverse the payments first.");

  if (bill.entry) {
    await assertPeriodUnlocked(companyId, bill.entry.date); // reverse only in an unlocked period
    const entryId = bill.entry.id;
    await prisma.$transaction([
      prisma.bill.update({ where: { id: billId }, data: { status: "VOID", journalEntryId: null } }),
      prisma.journalEntry.delete({ where: { id: entryId } }), // reverses the Dr expense / Cr 2200
    ]);
  } else {
    await prisma.bill.update({ where: { id: billId }, data: { status: "VOID" } });
  }
}

// ---------- Queries for pages / reports ----------
export interface BillWithBalance {
  id: string;
  supplierId: string;
  supplierName: string;
  propertyName: string | null;
  billDate: Date;
  dueDate: Date;
  reference: string | null;
  description: string;
  amount: number;
  paid: number;
  balance: number;
  status: string;
}

export async function listBills(
  companyId: string,
  filter: { status?: string; supplierId?: string; propertyId?: string } = {}
): Promise<BillWithBalance[]> {
  const bills = await prisma.bill.findMany({
    where: {
      companyId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.supplierId ? { supplierId: filter.supplierId } : {}),
      ...(filter.propertyId ? { propertyId: filter.propertyId } : {}),
    },
    include: { supplier: true, property: true, payments: true },
    orderBy: [{ dueDate: "asc" }],
  });
  return bills.map((b) => {
    const paid = b.payments.reduce((s, p) => s + Number(p.amount), 0);
    return {
      id: b.id,
      supplierId: b.supplierId,
      supplierName: b.supplier.name,
      propertyName: b.property?.name ?? null,
      billDate: b.billDate,
      dueDate: b.dueDate,
      reference: b.reference,
      description: b.description,
      amount: Number(b.amount),
      paid,
      balance: Number(b.amount) - paid,
      status: b.status,
    };
  });
}

/** Bills for AP aging (excludes VOID). */
export async function getApAgingData(companyId: string): Promise<ApBill[]> {
  const bills = await prisma.bill.findMany({
    where: { companyId, status: { not: "VOID" } },
    include: { supplier: true, payments: true },
  });
  return bills.map((b) => ({
    supplierId: b.supplierId,
    supplierName: b.supplier.name,
    dueDate: b.dueDate,
    amount: b.amount.toString(),
    paid: b.payments.reduce((s, p) => s + Number(p.amount), 0).toFixed(2),
  }));
}

/** Supplier statement lines: bills (charges) + payments, in date order. */
export async function getSupplierStatementLines(companyId: string, supplierId: string): Promise<StatementInputLine[]> {
  const bills = await prisma.bill.findMany({
    where: { companyId, supplierId, status: { not: "VOID" } },
    include: { payments: true },
  });
  const lines: StatementInputLine[] = [];
  for (const b of bills) {
    lines.push({ date: b.billDate, description: `Bill: ${b.description}${b.reference ? ` (${b.reference})` : ""}`, debit: b.amount.toString(), credit: "0" });
    for (const p of b.payments) lines.push({ date: p.date, description: `Payment — ${b.description}`, debit: "0", credit: p.amount.toString() });
  }
  return lines;
}

export interface BillDue {
  id: string;
  supplierName: string;
  description: string;
  dueDate: Date;
  balance: number;
  overdue: boolean;
}

/** Open/partial bills due within `withinDays` OR already overdue (for alerts). */
export async function getBillsDue(companyId: string, now = new Date(), withinDays = 14): Promise<BillDue[]> {
  const horizon = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
  const bills = await prisma.bill.findMany({
    where: { companyId, status: { in: ["OPEN", "PARTIALLY_PAID"] }, dueDate: { lte: horizon } },
    include: { supplier: true, payments: true },
    orderBy: { dueDate: "asc" },
  });
  return bills.map((b) => {
    const paid = b.payments.reduce((s, p) => s + Number(p.amount), 0);
    return {
      id: b.id,
      supplierName: b.supplier.name,
      description: b.description,
      dueDate: b.dueDate,
      balance: Number(b.amount) - paid,
      overdue: b.dueDate < now,
    };
  }).filter((b) => b.balance > 0.005);
}

/** Per-supplier outstanding balance (for the supplier list). */
export async function supplierBalances(companyId: string): Promise<Map<string, number>> {
  const bills = await prisma.bill.findMany({
    where: { companyId, status: { not: "VOID" } },
    include: { payments: true },
  });
  const map = new Map<string, number>();
  for (const b of bills) {
    const paid = b.payments.reduce((s, p) => s + Number(p.amount), 0);
    map.set(b.supplierId, (map.get(b.supplierId) ?? 0) + Number(b.amount) - paid);
  }
  return map;
}
