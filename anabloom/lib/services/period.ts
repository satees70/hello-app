import { prisma } from "../prisma";

export function yearMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class LockedPeriodError extends Error {
  constructor(ym: string) {
    super(`Accounting period ${ym} is locked. Unlock it in Settings to make changes.`);
  }
}

export async function assertPeriodUnlocked(companyId: string, date: Date): Promise<void> {
  const ym = yearMonth(date);
  const lock = await prisma.lockedPeriod.findUnique({
    where: { companyId_yearMonth: { companyId, yearMonth: ym } },
  });
  if (lock) throw new LockedPeriodError(ym);
}

export async function isPeriodLocked(companyId: string, date: Date): Promise<boolean> {
  const lock = await prisma.lockedPeriod.findUnique({
    where: { companyId_yearMonth: { companyId, yearMonth: yearMonth(date) } },
  });
  return !!lock;
}
