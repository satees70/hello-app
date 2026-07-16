import { straightLineSchedule } from "../depreciation";
import { prisma } from "../prisma";
import { createEntry } from "./entries";
import { LockedPeriodError } from "./period";

/**
 * Post straight-line monthly depreciation for every non-disposed asset in a
 * company up to `upToYearMonth` ("YYYY-MM"). One journal per asset per month
 * (Dr 5700, Cr 1590), idempotent (skips months already posted), stops at
 * salvage value.
 */
export async function runDepreciation(companyId: string, upToYearMonth: string): Promise<number> {
  const assets = await prisma.fixedAsset.findMany({ where: { companyId, disposedAt: null } });
  let posted = 0;

  for (const asset of assets) {
    const schedule = straightLineSchedule(
      {
        cost: asset.cost.toString(),
        salvageValue: asset.salvageValue.toString(),
        usefulLifeMonths: asset.usefulLifeMonths,
        purchaseDate: asset.purchaseDate,
      },
      upToYearMonth
    );

    const existing = await prisma.journalEntry.findMany({
      where: { companyId, sourceType: "DEPRECIATION", fixedAssetId: asset.id },
      select: { periodKey: true },
    });
    const done = new Set(existing.map((e) => e.periodKey));

    for (const period of schedule) {
      if (done.has(period.yearMonth)) continue;
      const [y, m] = period.yearMonth.split("-").map(Number);
      const date = new Date(Date.UTC(y, m - 1, 28)); // post at month end
      try {
        await createEntry({
          companyId,
          propertyId: asset.propertyId,
          date,
          description: `Depreciation — ${asset.name} (${period.yearMonth})`,
          sourceType: "DEPRECIATION",
          amount: period.amount.toString(),
          periodKey: period.yearMonth,
          fixedAssetId: asset.id,
        });
        posted++;
      } catch (e) {
        if (e instanceof LockedPeriodError) continue;
        throw e;
      }
    }
  }
  return posted;
}
