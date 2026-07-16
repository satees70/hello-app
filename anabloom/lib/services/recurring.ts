import { prisma } from "../prisma";
import { createEntry } from "./entries";
import { LockedPeriodError } from "./period";

function ym(y: number, m0: number): string {
  return `${y}-${String(m0 + 1).padStart(2, "0")}`;
}

/**
 * Idempotent recurring rent invoicing. For each ACTIVE, auto-invoicing lease,
 * generate a "Rent invoiced" entry (Dr 1100 AR, Cr 4000) for every month from
 * the lease start up to `now` whose due day has passed — unless one already
 * exists (unique constraint on lease + periodKey guarantees no duplicates).
 *
 * Runs from the Vercel Cron endpoint AND on login/dashboard load, so no month
 * is ever skipped or double-invoiced.
 */
export async function catchUpInvoices(userId: string, now: Date = new Date()): Promise<number> {
  const leases = await prisma.lease.findMany({
    where: { userId, status: "ACTIVE", autoInvoice: true },
  });

  let created = 0;
  for (const lease of leases) {
    const existing = await prisma.journalEntry.findMany({
      where: { leaseId: lease.id, sourceType: "RENT_INVOICED", periodKey: { not: null } },
      select: { periodKey: true },
    });
    const done = new Set(existing.map((e) => e.periodKey));

    const start = lease.startDate;
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth();
    const nowY = now.getUTCFullYear();
    const nowM = now.getUTCMonth();

    // walk months from lease start to current month
    for (let guard = 0; guard < 600; guard++) {
      const past = year < nowY || (year === nowY && month <= nowM);
      if (!past) break;

      const key = ym(year, month);
      const dueDay = Math.min(Math.max(lease.dueDay, 1), 28);
      const invoiceDate = new Date(Date.UTC(year, month, dueDay));

      const beforeStart = invoiceDate < new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
      const afterEnd = lease.endDate ? invoiceDate > lease.endDate : false;
      const dueReached = !(year === nowY && month === nowM) || now.getUTCDate() >= dueDay;

      if (!done.has(key) && !beforeStart && !afterEnd && dueReached) {
        try {
          await createEntry({
            userId,
            leaseId: lease.id,
            propertyId: lease.propertyId,
            date: invoiceDate,
            description: `Rent invoiced (${key})`,
            sourceType: "RENT_INVOICED",
            amount: lease.monthlyRent.toString(),
            periodKey: key,
          });
          created++;
        } catch (e) {
          // Skip locked months and races on the unique constraint.
          if (e instanceof LockedPeriodError) {
            /* month locked — skip */
          } else if (typeof e === "object" && e && "code" in e && (e as { code: string }).code === "P2002") {
            /* already created concurrently */
          } else {
            throw e;
          }
        }
      }

      month++;
      if (month > 11) {
        month = 0;
        year++;
      }
    }
  }
  return created;
}
