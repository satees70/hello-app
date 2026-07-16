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

async function reset(userId: string) {
  await prisma.journalEntry.deleteMany({ where: { userId } });
  await prisma.lease.deleteMany({ where: { userId } });
  await prisma.tenant.deleteMany({ where: { userId } });
  await prisma.property.deleteMany({ where: { userId } });
  await prisma.fixedAsset.deleteMany({ where: { userId } });
  await prisma.bankStatement.deleteMany({ where: { userId } });
  await prisma.lockedPeriod.deleteMany({ where: { userId } });
  await prisma.account.deleteMany({ where: { userId } });
}

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) await reset(existing.id);

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: { passwordHash: await hash(DEMO_PASSWORD, 10) },
    create: { email: DEMO_EMAIL, name: "Demo Owner", passwordHash: await hash(DEMO_PASSWORD, 10), currency: "RM" },
  });
  const userId = user.id;
  await seedChartOfAccounts(userId);

  // Properties
  const p1 = await prisma.property.create({ data: { userId, name: "Jalan Ampang Condo", address: "12 Jalan Ampang, KL", monthlyRent: "1800" } });
  const p2 = await prisma.property.create({ data: { userId, name: "Bangsar Shoplot", address: "8 Jalan Telawi, Bangsar", monthlyRent: "2500" } });
  const p3 = await prisma.property.create({ data: { userId, name: "PJ Terrace House", address: "3 Jalan SS2, Petaling Jaya", monthlyRent: "1500" } });

  // Tenants
  const t1 = await prisma.tenant.create({ data: { userId, name: "Alice Tan", phone: "012-3456789", email: "alice@example.com", idNumber: "880101-14-5501" } });
  const t2 = await prisma.tenant.create({ data: { userId, name: "Bobby Lim", phone: "013-2223344", email: "bobby@example.com", idNumber: "900202-10-1234" } });
  const t3 = await prisma.tenant.create({ data: { userId, name: "Chandra Nair", phone: "016-7778899", email: "chandra@example.com", idNumber: "850303-08-4321" } });

  // Leases
  // A: healthy, stamped
  const leaseA = await prisma.lease.create({
    data: { userId, propertyId: p1.id, tenantId: t1.id, startDate: d("2026-01-01"), endDate: d("2026-12-31"), monthlyRent: "1800", dueDay: 1, depositAmount: "3600", signedDate: d("2025-12-20"), stampedDate: d("2025-12-28"), autoInvoice: false },
  });
  // B: expiring within 60 days (today ~2026-07-16), stamped
  const leaseB = await prisma.lease.create({
    data: { userId, propertyId: p2.id, tenantId: t2.id, startDate: d("2025-09-05"), endDate: d("2026-09-04"), monthlyRent: "2500", dueDay: 5, depositAmount: "5000", signedDate: d("2025-08-25"), stampedDate: d("2025-09-01"), autoInvoice: false },
  });
  // C: unstamped + in arrears
  const leaseC = await prisma.lease.create({
    data: { userId, propertyId: p3.id, tenantId: t3.id, startDate: d("2026-03-01"), endDate: d("2027-02-28"), monthlyRent: "1500", dueDay: 1, depositAmount: "3000", signedDate: d("2026-02-25"), stampedDate: null, autoInvoice: false },
  });

  const post = (input: Parameters<typeof createEntry>[0]) => createEntry(input);

  // Opening capital + loan + deposits
  await post({ userId, date: d("2026-01-01"), description: "Owner capital injection", sourceType: "OWNER_CAPITAL", amount: "200000" });
  await post({ userId, date: d("2026-01-05"), description: "Mortgage drawdown", sourceType: "LOAN_RECEIVED", amount: "120000" });
  await post({ userId, leaseId: leaseA.id, propertyId: p1.id, date: d("2026-01-01"), description: "Deposit — Alice", sourceType: "DEPOSIT_RECEIVED", amount: "3600" });
  await post({ userId, leaseId: leaseB.id, propertyId: p2.id, date: d("2025-09-05"), description: "Deposit — Bobby", sourceType: "DEPOSIT_RECEIVED", amount: "5000" });
  await post({ userId, leaseId: leaseC.id, propertyId: p3.id, date: d("2026-03-01"), description: "Deposit — Chandra", sourceType: "DEPOSIT_RECEIVED", amount: "3000" });

  // Fixed asset + purchase
  const asset = await prisma.fixedAsset.create({
    data: { userId, propertyId: p1.id, name: "Condo furniture package", cost: "12000", purchaseDate: d("2026-02-01"), usefulLifeMonths: 36, salvageValue: "0", assetAccountCode: "1510" },
  });
  await post({ userId, propertyId: p1.id, fixedAssetId: asset.id, date: d("2026-02-01"), description: "Asset purchased — Condo furniture", sourceType: "ASSET_PURCHASED", amount: "12000", assetAccountCode: "1510", fundingAccountCode: "1000" });

  // Rent received A & B for Mar..Jul; parking; late fee
  for (const m of ["03", "04", "05", "06", "07"]) {
    await post({ userId, leaseId: leaseA.id, propertyId: p1.id, date: d(`2026-${m}-01`), description: "Rent received — Alice", sourceType: "RENT_RECEIVED", amount: "1800" });
    await post({ userId, leaseId: leaseB.id, propertyId: p2.id, date: d(`2026-${m}-05`), description: "Rent received — Bobby", sourceType: "RENT_RECEIVED", amount: "2500" });
  }
  await post({ userId, propertyId: p1.id, date: d("2026-04-10"), description: "Parking income", sourceType: "OTHER_INCOME_RECEIVED", amount: "150", incomeAccountCode: "4200" });
  await post({ userId, propertyId: p2.id, date: d("2026-05-12"), description: "Parking income", sourceType: "OTHER_INCOME_RECEIVED", amount: "150", incomeAccountCode: "4200" });
  await post({ userId, propertyId: p3.id, date: d("2026-06-06"), description: "Late fee", sourceType: "OTHER_INCOME_RECEIVED", amount: "80", incomeAccountCode: "4100" });

  // Lease C in arrears: invoice Apr..Jun (no payment). periodKey set so catch-up won't duplicate.
  for (const m of ["04", "05", "06"]) {
    await post({ userId, leaseId: leaseC.id, propertyId: p3.id, date: d(`2026-${m}-01`), description: `Rent invoiced (2026-${m})`, sourceType: "RENT_INVOICED", amount: "1500", periodKey: `2026-${m}` });
  }
  // C paid March only
  await post({ userId, leaseId: leaseC.id, propertyId: p3.id, date: d("2026-03-01"), description: "Rent received — Chandra", sourceType: "RENT_RECEIVED", amount: "1500" });

  // Expenses across months
  const expenses: [string, string, string, string][] = [
    ["2026-03-05", "TNB utilities", "5100", "310.40"],
    ["2026-03-18", "Plumbing repair", "5000", "480.00"],
    ["2026-04-05", "TNB utilities", "5100", "298.75"],
    ["2026-04-20", "Fire insurance premium", "5200", "1200.00"],
    ["2026-05-05", "TNB utilities", "5100", "325.10"],
    ["2026-05-15", "Cleaning service", "5600", "260.00"],
    ["2026-05-25", "Quit rent & assessment", "5300", "680.00"],
    ["2026-06-05", "TNB utilities", "5100", "340.00"],
    ["2026-06-15", "Property management fee", "5400", "450.00"],
    ["2026-07-05", "TNB utilities", "5100", "320.50"],
    ["2026-07-08", "Roof maintenance", "5000", "450.00"],
    ["2026-07-15", "Cleaning service", "5600", "180.00"],
  ];
  for (const [date, desc, code, amt] of expenses) {
    await post({ userId, propertyId: p1.id, date: d(date), description: desc, sourceType: "EXPENSE_PAID", amount: amt, expenseAccountCode: code });
  }

  // A bill on credit + pay it
  await post({ userId, propertyId: p2.id, date: d("2026-06-20"), description: "Aircond servicing (invoice)", sourceType: "EXPENSE_ON_CREDIT", amount: "600", expenseAccountCode: "5000" });
  await post({ userId, propertyId: p2.id, date: d("2026-07-02"), description: "Pay aircond bill", sourceType: "PAY_BILL", amount: "600" });

  // Loan repayments (principal + interest)
  await post({ userId, date: d("2026-04-28"), description: "Mortgage repayment", sourceType: "LOAN_REPAYMENT", principal: "800", interest: "500" });
  await post({ userId, date: d("2026-05-28"), description: "Mortgage repayment", sourceType: "LOAN_REPAYMENT", principal: "805", interest: "495" });
  await post({ userId, date: d("2026-06-28"), description: "Mortgage repayment", sourceType: "LOAN_REPAYMENT", principal: "810", interest: "490" });

  // Owner drawings
  await post({ userId, date: d("2026-05-30"), description: "Owner drawings", sourceType: "OWNER_DRAWINGS", amount: "2000" });

  // Run depreciation Feb..Jun (several months posted)
  await runDepreciation(userId, "2026-06");

  // Sample bank statement (July) — a couple of lines missing from books (bank
  // charges, parking) and one book entry (15 Jul cleaning) missing from the
  // statement, so the reconciliation demo is realistic.
  await prisma.bankStatement.create({
    data: {
      userId,
      fileName: "sample-july-2026.csv",
      bankName: "Maybank",
      periodStart: d("2026-07-01"),
      periodEnd: d("2026-07-31"),
      openingBalance: "10000.00",
      closingBalance: "13664.50",
      status: "DRAFT",
      lines: {
        create: [
          { date: d("2026-07-01"), description: "RENTAL PAYMENT ALICE", amount: "1800.00", runningBalance: "11800.00", sortOrder: 0 },
          { date: d("2026-07-02"), description: "RENTAL PAYMENT BOBBY", amount: "2500.00", runningBalance: "14300.00", sortOrder: 1 },
          { date: d("2026-07-05"), description: "TNB UTILITIES", amount: "-320.50", runningBalance: "13979.50", sortOrder: 2 },
          { date: d("2026-07-08"), description: "ROOF MAINTENANCE", amount: "-450.00", runningBalance: "13529.50", sortOrder: 3 },
          { date: d("2026-07-10"), description: "MONTHLY BANK CHARGES", amount: "-15.00", runningBalance: "13514.50", sortOrder: 4 },
          { date: d("2026-07-12"), description: "PARKING COLLECTION", amount: "150.00", runningBalance: "13664.50", sortOrder: 5 },
        ],
      },
    },
  });

  console.log(`\nSeeded demo data for ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
