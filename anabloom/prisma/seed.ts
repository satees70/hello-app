import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { seedChartOfAccounts } from "../lib/services/accountsSeed";
import { createEntry } from "../lib/services/entries";
import { runDepreciation } from "../lib/services/depreciation";

const prisma = new PrismaClient();

const DEMO_EMAIL = "demo@example.com";
const DEMO_PASSWORD = "demo1234";

function d(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

async function main() {
  // Reset with explicit ordered deletes (children first) to avoid the several
  // restrict FKs among a company's children (Lease->Property, FixedAsset->
  // Property, JournalLine->Account) that make a blind cascade order-dependent.
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    const cos = await prisma.company.findMany({ where: { userId: existing.id }, select: { id: true } });
    const inCo = { companyId: { in: cos.map((c) => c.id) } };
    await prisma.journalEntry.deleteMany({ where: inCo }); // cascades lines + attachments
    await prisma.bankStatement.deleteMany({ where: inCo }); // cascades statement lines
    await prisma.leaseDocument.deleteMany({ where: inCo });
    await prisma.attachment.deleteMany({ where: inCo });
    await prisma.lease.deleteMany({ where: inCo });
    await prisma.fixedAsset.deleteMany({ where: inCo });
    await prisma.tenant.deleteMany({ where: inCo });
    await prisma.property.deleteMany({ where: inCo });
    await prisma.lockedPeriod.deleteMany({ where: inCo });
    await prisma.account.deleteMany({ where: inCo });
    await prisma.company.deleteMany({ where: { userId: existing.id } });
    await prisma.user.delete({ where: { id: existing.id } });
  }

  const user = await prisma.user.create({
    data: { email: DEMO_EMAIL, name: "Demo Owner", passwordHash: await hash(DEMO_PASSWORD, 10) },
  });
  const userId = user.id;

  // ---------------- Company A: Anabloom Properties Sdn Bhd ----------------
  const coA = await prisma.company.create({
    data: { userId, name: "Anabloom Properties Sdn Bhd", registrationNo: "202301000111", currency: "RM" },
  });
  await seedChartOfAccounts(coA.id);

  const a1 = await prisma.property.create({ data: { companyId: coA.id, name: "Jalan Ampang Condo", address: "12 Jalan Ampang, KL", monthlyRent: "1800" } });
  const a2 = await prisma.property.create({ data: { companyId: coA.id, name: "Bangsar Shoplot", address: "8 Jalan Telawi, Bangsar", monthlyRent: "2500" } });
  const a3 = await prisma.property.create({ data: { companyId: coA.id, name: "PJ Terrace House", address: "3 Jalan SS2, PJ", monthlyRent: "1500" } });

  const ta1 = await prisma.tenant.create({ data: { companyId: coA.id, name: "Alice Tan", phone: "012-3456789", email: "alice@example.com" } });
  const ta2 = await prisma.tenant.create({ data: { companyId: coA.id, name: "Bobby Lim", phone: "013-2223344", email: "bobby@example.com" } });
  const ta3 = await prisma.tenant.create({ data: { companyId: coA.id, name: "Chandra Nair", phone: "016-7778899", email: "chandra@example.com" } });

  const la1 = await prisma.lease.create({ data: { companyId: coA.id, propertyId: a1.id, tenantId: ta1.id, startDate: d("2026-01-01"), endDate: d("2026-12-31"), monthlyRent: "1800", dueDay: 1, depositAmount: "3600", signedDate: d("2025-12-20"), stampedDate: d("2025-12-28"), autoInvoice: false } });
  await prisma.lease.create({ data: { companyId: coA.id, propertyId: a2.id, tenantId: ta2.id, startDate: d("2025-09-05"), endDate: d("2026-09-04"), monthlyRent: "2500", dueDay: 5, depositAmount: "5000", signedDate: d("2025-08-25"), stampedDate: d("2025-09-01"), autoInvoice: false } }); // expiring within 90d
  const la3 = await prisma.lease.create({ data: { companyId: coA.id, propertyId: a3.id, tenantId: ta3.id, startDate: d("2026-03-01"), endDate: d("2027-02-28"), monthlyRent: "1500", dueDay: 1, depositAmount: "3000", signedDate: d("2026-02-25"), stampedDate: null, autoInvoice: false } }); // unstamped

  await createEntry({ companyId: coA.id, date: d("2026-01-01"), description: "Owner capital", sourceType: "OWNER_CAPITAL", amount: "200000" });
  await createEntry({ companyId: coA.id, date: d("2026-01-05"), description: "Mortgage drawdown", sourceType: "LOAN_RECEIVED", amount: "120000" });
  await createEntry({ companyId: coA.id, leaseId: la1.id, propertyId: a1.id, date: d("2026-01-01"), description: "Deposit — Alice", sourceType: "DEPOSIT_RECEIVED", amount: "3600" });
  await createEntry({ companyId: coA.id, leaseId: la3.id, propertyId: a3.id, date: d("2026-03-01"), description: "Deposit — Chandra", sourceType: "DEPOSIT_RECEIVED", amount: "3000" });

  const assetA = await prisma.fixedAsset.create({ data: { companyId: coA.id, propertyId: a1.id, name: "Condo furniture", cost: "12000", purchaseDate: d("2026-02-01"), usefulLifeMonths: 36, salvageValue: "0", assetAccountCode: "1510" } });
  await createEntry({ companyId: coA.id, propertyId: a1.id, fixedAssetId: assetA.id, date: d("2026-02-01"), description: "Asset purchased — Condo furniture", sourceType: "ASSET_PURCHASED", amount: "12000", assetAccountCode: "1510", fundingAccountCode: "1000" });

  for (const m of ["03", "04", "05", "06", "07"]) {
    await createEntry({ companyId: coA.id, leaseId: la1.id, propertyId: a1.id, date: d(`2026-${m}-01`), description: "Rent received — Alice", sourceType: "RENT_RECEIVED", amount: "1800" });
  }
  // Chandra (la3) in arrears: invoiced Apr–Jun, paid only March
  await createEntry({ companyId: coA.id, leaseId: la3.id, propertyId: a3.id, date: d("2026-03-01"), description: "Rent received — Chandra", sourceType: "RENT_RECEIVED", amount: "1500" });
  for (const m of ["04", "05", "06"]) {
    await createEntry({ companyId: coA.id, leaseId: la3.id, propertyId: a3.id, date: d(`2026-${m}-01`), description: `Rent invoiced (2026-${m})`, sourceType: "RENT_INVOICED", amount: "1500", periodKey: `2026-${m}` });
  }
  const expA: [string, string, string, string][] = [
    ["2026-03-05", "TNB utilities", "5100", "310.40"],
    ["2026-04-20", "Fire insurance", "5200", "1200.00"],
    ["2026-05-25", "Quit rent & assessment", "5300", "680.00"],
    ["2026-06-15", "Management fee", "5400", "450.00"],
    ["2026-07-08", "Roof maintenance", "5000", "450.00"],
  ];
  for (const [dt, desc, code, amt] of expA) await createEntry({ companyId: coA.id, propertyId: a1.id, date: d(dt), description: desc, sourceType: "EXPENSE_PAID", amount: amt, expenseAccountCode: code });
  await createEntry({ companyId: coA.id, date: d("2026-05-30"), description: "Owner drawings", sourceType: "OWNER_DRAWINGS", amount: "2000" });
  await runDepreciation(coA.id, "2026-06");

  // Sample bank statement (Company A)
  await prisma.bankStatement.create({
    data: {
      companyId: coA.id, fileName: "sample-july-2026.csv", bankName: "Maybank",
      periodStart: d("2026-07-01"), periodEnd: d("2026-07-31"), openingBalance: "10000.00", closingBalance: "11665.00", status: "DRAFT",
      lines: { create: [
        { date: d("2026-07-01"), description: "RENTAL PAYMENT ALICE", amount: "1800.00", runningBalance: "11800.00", sortOrder: 0 },
        { date: d("2026-07-08"), description: "ROOF MAINTENANCE", amount: "-450.00", runningBalance: "11350.00", sortOrder: 1 },
        { date: d("2026-07-10"), description: "MONTHLY BANK CHARGES", amount: "-15.00", runningBalance: "11335.00", sortOrder: 2 },
        { date: d("2026-07-12"), description: "PARKING COLLECTION", amount: "330.00", runningBalance: "11665.00", sortOrder: 3 },
      ] },
    },
  });

  // ---------------- Company B: Anabloom Ventures Sdn Bhd ----------------
  const coB = await prisma.company.create({
    data: { userId, name: "Anabloom Ventures Sdn Bhd", registrationNo: "202401000222", currency: "RM" },
  });
  await seedChartOfAccounts(coB.id);

  const b1 = await prisma.property.create({ data: { companyId: coB.id, name: "Cheras Retail Lot", address: "5 Jalan Cheras, KL", monthlyRent: "3200" } });
  const b2 = await prisma.property.create({ data: { companyId: coB.id, name: "Subang Warehouse", address: "22 Jalan USJ, Subang", monthlyRent: "4500" } });
  const tb1 = await prisma.tenant.create({ data: { companyId: coB.id, name: "Delta Trading Sdn Bhd", email: "ap@delta.com" } });
  const tb2 = await prisma.tenant.create({ data: { companyId: coB.id, name: "Evergreen Logistics", email: "finance@evergreen.com" } });
  const lb1 = await prisma.lease.create({ data: { companyId: coB.id, propertyId: b1.id, tenantId: tb1.id, startDate: d("2026-01-01"), endDate: d("2026-12-31"), monthlyRent: "3200", dueDay: 1, depositAmount: "6400", signedDate: d("2025-12-15"), stampedDate: d("2025-12-22"), autoInvoice: false } });
  const lb2 = await prisma.lease.create({ data: { companyId: coB.id, propertyId: b2.id, tenantId: tb2.id, startDate: d("2026-02-01"), endDate: d("2027-01-31"), monthlyRent: "4500", dueDay: 1, depositAmount: "9000", signedDate: d("2026-01-20"), stampedDate: d("2026-01-28"), autoInvoice: false } });

  await createEntry({ companyId: coB.id, date: d("2026-01-01"), description: "Owner capital", sourceType: "OWNER_CAPITAL", amount: "80000" });
  await createEntry({ companyId: coB.id, leaseId: lb1.id, propertyId: b1.id, date: d("2026-01-01"), description: "Deposit — Delta", sourceType: "DEPOSIT_RECEIVED", amount: "6400" });
  await createEntry({ companyId: coB.id, leaseId: lb2.id, propertyId: b2.id, date: d("2026-02-01"), description: "Deposit — Evergreen", sourceType: "DEPOSIT_RECEIVED", amount: "9000" });
  for (const m of ["03", "04", "05", "06", "07"]) {
    await createEntry({ companyId: coB.id, leaseId: lb1.id, propertyId: b1.id, date: d(`2026-${m}-01`), description: "Rent received — Delta", sourceType: "RENT_RECEIVED", amount: "3200" });
    await createEntry({ companyId: coB.id, leaseId: lb2.id, propertyId: b2.id, date: d(`2026-${m}-01`), description: "Rent received — Evergreen", sourceType: "RENT_RECEIVED", amount: "4500" });
  }
  const expB: [string, string, string, string][] = [
    ["2026-03-10", "Utilities", "5100", "620.00"],
    ["2026-04-12", "Security services", "5400", "900.00"],
    ["2026-06-18", "Warehouse repairs", "5000", "1500.00"],
  ];
  for (const [dt, desc, code, amt] of expB) await createEntry({ companyId: coB.id, propertyId: b1.id, date: d(dt), description: desc, sourceType: "EXPENSE_PAID", amount: amt, expenseAccountCode: code });
  const assetB = await prisma.fixedAsset.create({ data: { companyId: coB.id, propertyId: b2.id, name: "Forklift", cost: "36000", purchaseDate: d("2026-02-01"), usefulLifeMonths: 60, salvageValue: "6000", assetAccountCode: "1520" } });
  await createEntry({ companyId: coB.id, propertyId: b2.id, fixedAssetId: assetB.id, date: d("2026-02-01"), description: "Asset purchased — Forklift", sourceType: "ASSET_PURCHASED", amount: "36000", assetAccountCode: "1520", fundingAccountCode: "1000" });
  await runDepreciation(coB.id, "2026-06");

  // ---------------- Inter-company loan: A lends RM 50,000 to B ----------------
  await prisma.account.create({ data: { companyId: coA.id, code: "1200", name: "Inter-company receivable — Ventures", type: "ASSET", isSystem: false } });
  await prisma.account.create({ data: { companyId: coB.id, code: "2300", name: "Inter-company payable — Properties", type: "LIABILITY", isSystem: false } });
  // Company A: money out of cash, booked as a receivable from B
  await createEntry({
    companyId: coA.id, date: d("2026-04-01"), description: "Inter-company loan to Ventures",
    sourceType: "MANUAL", manualLines: [
      { accountCode: "1200", debit: "50000", credit: "0" },
      { accountCode: "1000", debit: "0", credit: "50000" },
    ],
  });
  // Company B: money into cash, booked as a payable to A
  await createEntry({
    companyId: coB.id, date: d("2026-04-01"), description: "Inter-company loan from Properties",
    sourceType: "MANUAL", manualLines: [
      { accountCode: "1000", debit: "50000", credit: "0" },
      { accountCode: "2300", debit: "0", credit: "50000" },
    ],
  });

  console.log(`\nSeeded demo data for ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`  Company A: ${coA.name}  (${coA.id})`);
  console.log(`  Company B: ${coB.name}  (${coB.id})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
