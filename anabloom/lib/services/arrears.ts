import { AgingInvoice, AgingPayment, arAging } from "../reports";
import { prisma } from "../prisma";

/** Gather AR invoice/payment data (account 1100) grouped by lease. */
export async function getAgingReport(userId: string, asOf: Date = new Date()) {
  const lines = await prisma.journalLine.findMany({
    where: { account: { userId, code: "1100" }, entry: { leaseId: { not: null } } },
    include: { entry: { include: { lease: { include: { tenant: true, property: true } } } } },
  });

  const invoices: AgingInvoice[] = [];
  const payments: AgingPayment[] = [];
  for (const l of lines) {
    const lease = l.entry.lease;
    if (!lease) continue;
    const debit = Number(l.debit);
    const credit = Number(l.credit);
    if (debit > 0) {
      invoices.push({
        leaseId: lease.id,
        tenantName: lease.tenant.name,
        propertyName: lease.property.name,
        date: l.entry.date,
        amount: l.debit.toString(),
      });
    }
    if (credit > 0) {
      payments.push({ leaseId: lease.id, amount: l.credit.toString() });
    }
  }
  return arAging(invoices, payments, asOf);
}
