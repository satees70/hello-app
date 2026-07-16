import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedChartOfAccounts } from "@/lib/services/accountsSeed";
import { createEntry, deleteEntry } from "@/lib/services/entries";
import { catchUpInvoices } from "@/lib/services/recurring";
import { renewLease } from "@/lib/services/leases";
import { LockedPeriodError } from "@/lib/services/period";
import { getLedgerLines } from "@/lib/services/ledger";
import { balanceSheet } from "@/lib/reports";

let userId: string;
let companyId: string;
let propertyId: string;
let tenantId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `it-${Date.now()}@test.local`, passwordHash: "x", name: "IT" },
  });
  userId = user.id;
  const company = await prisma.company.create({ data: { userId, name: "IT Co", currency: "RM" } });
  companyId = company.id;
  await seedChartOfAccounts(companyId);
  const p = await prisma.property.create({ data: { companyId, name: "Unit IT", monthlyRent: "1500" } });
  propertyId = p.id;
  const t = await prisma.tenant.create({ data: { companyId, name: "Tenant IT" } });
  tenantId = t.id;
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("recurring rent invoicing idempotency", () => {
  it("running the catch-up twice creates no duplicate invoices", async () => {
    const lease = await prisma.lease.create({
      data: { companyId, propertyId, tenantId, startDate: new Date(Date.UTC(2026, 0, 1)), monthlyRent: "1500", dueDay: 1, autoInvoice: true },
    });
    const now = new Date(Date.UTC(2026, 3, 15)); // Jan..Apr => 4 invoices
    const first = await catchUpInvoices(companyId, now);
    const second = await catchUpInvoices(companyId, now);
    expect(first).toBe(4);
    expect(second).toBe(0);
    const invoices = await prisma.journalEntry.count({ where: { leaseId: lease.id, sourceType: "RENT_INVOICED" } });
    expect(invoices).toBe(4);
  });
});

describe("period locking enforced server-side", () => {
  it("rejects create/edit/delete of entries dated in a locked month", async () => {
    const date = new Date(Date.UTC(2025, 5, 10));
    const entry = await createEntry({ companyId, date, description: "before lock", sourceType: "RENT_RECEIVED", amount: "500" });
    await prisma.lockedPeriod.create({ data: { companyId, yearMonth: "2025-06" } });
    await expect(
      createEntry({ companyId, date, description: "blocked", sourceType: "RENT_RECEIVED", amount: "100" })
    ).rejects.toBeInstanceOf(LockedPeriodError);
    await expect(deleteEntry(companyId, entry.id)).rejects.toThrow(/locked/i);
    await prisma.lockedPeriod.delete({ where: { companyId_yearMonth: { companyId, yearMonth: "2025-06" } } });
    await deleteEntry(companyId, entry.id);
  });
});

describe("lease renewal carries the deposit forward without double-posting", () => {
  it("does not create a duplicate deposit liability on renewal", async () => {
    const lease = await prisma.lease.create({
      data: { companyId, propertyId, tenantId, startDate: new Date(Date.UTC(2026, 0, 1)), endDate: new Date(Date.UTC(2026, 11, 31)), monthlyRent: "1500", dueDay: 1, depositAmount: "3000", autoInvoice: false },
    });
    await createEntry({ companyId, leaseId: lease.id, propertyId, date: new Date(Date.UTC(2026, 0, 1)), description: "Deposit received", sourceType: "DEPOSIT_RECEIVED", amount: "3000" });
    const before = (await getLedgerLines(companyId)).filter((l) => l.accountCode === "2000").reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);
    const renewed = await renewLease({ companyId, leaseId: lease.id, startDate: new Date(Date.UTC(2027, 0, 1)), endDate: new Date(Date.UTC(2027, 11, 31)), monthlyRent: "1650" });
    const after = (await getLedgerLines(companyId)).filter((l) => l.accountCode === "2000").reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);
    expect(renewed.renewedFromLeaseId).toBe(lease.id);
    expect(renewed.depositAmount.toString()).toBe("3000");
    expect(after).toBe(before);
  });
});

describe("books always balance", () => {
  it("the balance sheet equation holds after all operations", async () => {
    const bs = balanceSheet(await getLedgerLines(companyId));
    expect(bs.balanced).toBe(true);
  });
});
