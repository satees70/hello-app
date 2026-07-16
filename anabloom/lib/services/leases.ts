import { prisma } from "../prisma";
import { createEntry } from "./entries";

export interface RenewLeaseInput {
  userId: string;
  leaseId: string;
  startDate: Date;
  endDate?: Date | null;
  monthlyRent: number | string;
  dueDay?: number;
  signedDate?: Date | null;
  stampedDate?: Date | null;
  noticePeriodDays?: number | null;
}

/**
 * Renew a lease: end the old term and create a new one linked via
 * renewedFromLeaseId. The deposit is carried forward WITHOUT posting a new
 * deposit liability (it was already booked on the original lease).
 */
export async function renewLease(input: RenewLeaseInput) {
  const old = await prisma.lease.findFirst({ where: { id: input.leaseId, userId: input.userId } });
  if (!old) throw new Error("Lease not found.");

  return prisma.$transaction(async (tx) => {
    const priorDayEnd = new Date(input.startDate.getTime() - 24 * 60 * 60 * 1000);
    await tx.lease.update({
      where: { id: old.id },
      data: { status: "ENDED", endDate: old.endDate ?? priorDayEnd },
    });
    return tx.lease.create({
      data: {
        userId: input.userId,
        propertyId: old.propertyId,
        tenantId: old.tenantId,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        monthlyRent: input.monthlyRent.toString(),
        dueDay: input.dueDay ?? old.dueDay,
        depositAmount: old.depositAmount, // carried forward — no new posting
        status: "ACTIVE",
        signedDate: input.signedDate ?? null,
        stampedDate: input.stampedDate ?? null,
        noticePeriodDays: input.noticePeriodDays ?? old.noticePeriodDays,
        renewedFromLeaseId: old.id,
        autoInvoice: old.autoInvoice,
      },
    });
  });
}

export type DepositDisposition = "refund" | "apply" | "forfeit" | "none";

export interface EndLeaseInput {
  userId: string;
  leaseId: string;
  endDate: Date;
  deposit: DepositDisposition;
  depositAmount?: number | string; // defaults to lease.depositAmount
}

/** End a lease and settle the deposit (refund / apply to arrears / forfeit). */
export async function endLease(input: EndLeaseInput) {
  const lease = await prisma.lease.findFirst({ where: { id: input.leaseId, userId: input.userId } });
  if (!lease) throw new Error("Lease not found.");

  await prisma.lease.update({
    where: { id: lease.id },
    data: { status: "ENDED", endDate: input.endDate },
  });

  const amount = input.depositAmount ?? lease.depositAmount.toString();
  if (input.deposit === "none" || Number(amount) <= 0) return;

  const sourceType =
    input.deposit === "refund" ? "DEPOSIT_REFUNDED" : input.deposit === "apply" ? "DEPOSIT_APPLIED" : "DEPOSIT_FORFEIT";

  await createEntry({
    userId: input.userId,
    leaseId: lease.id,
    propertyId: lease.propertyId,
    date: input.endDate,
    description: `Deposit ${input.deposit} — end of lease`,
    sourceType,
    amount: amount.toString(),
  });
}
