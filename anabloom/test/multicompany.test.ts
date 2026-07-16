import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedChartOfAccounts } from "@/lib/services/accountsSeed";
import { createEntry } from "@/lib/services/entries";
import { getLedgerLines } from "@/lib/services/ledger";
import { getAgingReport } from "@/lib/services/arrears";

// Two companies A and B under the SAME user — prove nothing leaks across them.
let userId: string;
let A: string;
let B: string;
let propA: string;
let propB: string;

beforeAll(async () => {
  const user = await prisma.user.create({ data: { email: `mc-${Date.now()}@test.local`, passwordHash: "x" } });
  userId = user.id;
  const ca = await prisma.company.create({ data: { userId, name: "Company A" } });
  const cb = await prisma.company.create({ data: { userId, name: "Company B" } });
  A = ca.id;
  B = cb.id;
  await seedChartOfAccounts(A);
  await seedChartOfAccounts(B);

  const pa = await prisma.property.create({ data: { companyId: A, name: "A-Prop", monthlyRent: "1000" } });
  const pb = await prisma.property.create({ data: { companyId: B, name: "B-Prop", monthlyRent: "2000" } });
  propA = pa.id;
  propB = pb.id;
  const ta = await prisma.tenant.create({ data: { companyId: A, name: "A-Tenant" } });
  const tb = await prisma.tenant.create({ data: { companyId: B, name: "B-Tenant" } });
  const la = await prisma.lease.create({ data: { companyId: A, propertyId: pa.id, tenantId: ta.id, startDate: new Date(Date.UTC(2026, 0, 1)), monthlyRent: "1000", depositAmount: "0" } });
  const lb = await prisma.lease.create({ data: { companyId: B, propertyId: pb.id, tenantId: tb.id, startDate: new Date(Date.UTC(2026, 0, 1)), monthlyRent: "2000", depositAmount: "0" } });

  await createEntry({ companyId: A, propertyId: propA, leaseId: la.id, date: new Date(Date.UTC(2026, 0, 5)), description: "A rent invoiced", sourceType: "RENT_INVOICED", amount: "1000" });
  await createEntry({ companyId: B, propertyId: propB, leaseId: lb.id, date: new Date(Date.UTC(2026, 0, 5)), description: "B rent invoiced", sourceType: "RENT_INVOICED", amount: "2000" });
});

afterAll(async () => {
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("tenant isolation — company A can never see company B's data", () => {
  it("properties are scoped by company", async () => {
    const aProps = await prisma.property.findMany({ where: { companyId: A } });
    expect(aProps.map((p) => p.name)).toEqual(["A-Prop"]);
    expect(aProps.find((p) => p.id === propB)).toBeUndefined();
  });

  it("accounts are scoped by company (separate charts)", async () => {
    const aAccounts = await prisma.account.findMany({ where: { companyId: A } });
    const bAccounts = await prisma.account.findMany({ where: { companyId: B } });
    const overlap = aAccounts.filter((a) => bAccounts.some((b) => b.id === a.id));
    expect(overlap.length).toBe(0);
  });

  it("journal entries + ledger lines are scoped by company", async () => {
    const aLines = await getLedgerLines(A);
    const bLines = await getLedgerLines(B);
    // A's rental income is 1000, B's is 2000 — never mixed
    const aIncome = aLines.filter((l) => l.accountCode === "4000").reduce((s, l) => s + Number(l.credit), 0);
    const bIncome = bLines.filter((l) => l.accountCode === "4000").reduce((s, l) => s + Number(l.credit), 0);
    expect(aIncome).toBe(1000);
    expect(bIncome).toBe(2000);
    const aEntries = await prisma.journalEntry.findMany({ where: { companyId: A } });
    expect(aEntries.every((e) => e.companyId === A)).toBe(true);
  });

  it("AR aging is scoped by company", async () => {
    const aAging = await getAgingReport(A, new Date(Date.UTC(2026, 2, 1)));
    const bAging = await getAgingReport(B, new Date(Date.UTC(2026, 2, 1)));
    expect(aAging.totals.total.toFixed(2)).toBe("1000.00");
    expect(bAging.totals.total.toFixed(2)).toBe("2000.00");
    expect(aAging.rows.every((r) => r.tenantName === "A-Tenant")).toBe(true);
  });

  it("a cross-company access attempt (A id + B filter) returns nothing", async () => {
    // Simulate a scoped query: asking for propB but scoped to company A must be empty.
    const leaked = await prisma.property.findFirst({ where: { id: propB, companyId: A } });
    expect(leaked).toBeNull();
    const leakedEntry = await prisma.journalEntry.findFirst({ where: { companyId: A, description: "B rent invoiced" } });
    expect(leakedEntry).toBeNull();
  });
});
