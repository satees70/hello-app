import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedChartOfAccounts } from "@/lib/services/accountsSeed";
import { createBill, payBills, voidBill, supplierBalances } from "@/lib/services/payables";
import { getLedgerLines } from "@/lib/services/ledger";

let userId: string;
let companyId: string;
let supplierId: string;

async function apBalance(): Promise<number> {
  const lines = await getLedgerLines(companyId);
  return lines.filter((l) => l.accountCode === "2200").reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);
}
async function unpaidBillsTotal(): Promise<number> {
  const bal = await supplierBalances(companyId);
  return [...bal.values()].reduce((s, v) => s + v, 0);
}

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `ap-${Date.now()}@test.local`, passwordHash: "x" } });
  userId = user.id;
  const c = await prisma.company.create({ data: { userId, name: "AP Co" } });
  companyId = c.id;
  await seedChartOfAccounts(companyId);
  const sup = await prisma.supplier.create({ data: { companyId, name: "Acme Supplies", defaultTermsDays: 30 } });
  supplierId = sup.id;
});

afterAll(async () => {
  await prisma.billPayment.deleteMany({ where: { bill: { companyId } } });
  await prisma.bill.deleteMany({ where: { companyId } });
  await prisma.journalEntry.deleteMany({ where: { companyId } });
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("AP invariant: 2200 balance always equals sum of unpaid bill balances", () => {
  let bill1: string;
  let bill2: string;

  it("holds after creating bills", async () => {
    const b1 = await createBill({ companyId, supplierId, billDate: new Date(Date.UTC(2026, 0, 1)), description: "Bill 1", amount: "1000", kind: "expense", accountCode: "5000" });
    const b2 = await createBill({ companyId, supplierId, billDate: new Date(Date.UTC(2026, 0, 5)), description: "Bill 2", amount: "500", kind: "expense", accountCode: "5100" });
    bill1 = b1.id;
    bill2 = b2.id;
    expect(await apBalance()).toBeCloseTo(1500, 2);
    expect(await unpaidBillsTotal()).toBeCloseTo(1500, 2);
  });

  it("holds after a partial payment", async () => {
    await payBills({ companyId, supplierId, date: new Date(Date.UTC(2026, 1, 1)), allocations: [{ billId: bill1, amount: "400" }] });
    const b1 = await prisma.bill.findUnique({ where: { id: bill1 } });
    expect(b1?.status).toBe("PARTIALLY_PAID");
    expect(await apBalance()).toBeCloseTo(1100, 2);
    expect(await unpaidBillsTotal()).toBeCloseTo(1100, 2);
  });

  it("holds after full payment and marks the bill PAID", async () => {
    await payBills({ companyId, supplierId, date: new Date(Date.UTC(2026, 1, 10)), allocations: [{ billId: bill1, amount: "600" }] });
    const b1 = await prisma.bill.findUnique({ where: { id: bill1 } });
    expect(b1?.status).toBe("PAID");
    expect(await apBalance()).toBeCloseTo(500, 2);
    expect(await unpaidBillsTotal()).toBeCloseTo(500, 2);
  });

  it("rejects a payment that exceeds the bill balance", async () => {
    await expect(
      payBills({ companyId, supplierId, date: new Date(Date.UTC(2026, 1, 15)), allocations: [{ billId: bill2, amount: "9999" }] })
    ).rejects.toThrow(/exceeds/i);
  });

  it("voiding an unpaid bill reverses its entry and keeps the invariant", async () => {
    await voidBill(companyId, bill2);
    const b2 = await prisma.bill.findUnique({ where: { id: bill2 } });
    expect(b2?.status).toBe("VOID");
    expect(await apBalance()).toBeCloseTo(0, 2);
    expect(await unpaidBillsTotal()).toBeCloseTo(0, 2);
  });

  it("refuses to void a bill that has payments", async () => {
    const b = await createBill({ companyId, supplierId, billDate: new Date(Date.UTC(2026, 2, 1)), description: "Bill 3", amount: "300", kind: "expense", accountCode: "5000" });
    await payBills({ companyId, supplierId, date: new Date(Date.UTC(2026, 2, 2)), allocations: [{ billId: b.id, amount: "100" }] });
    await expect(voidBill(companyId, b.id)).rejects.toThrow(/payments/i);
  });
});
