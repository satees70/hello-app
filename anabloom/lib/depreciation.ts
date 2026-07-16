import Decimal from "decimal.js";
import { add, money, round2, sub, ZERO } from "./money";

export interface DepreciableAsset {
  cost: Decimal.Value;
  salvageValue: Decimal.Value;
  usefulLifeMonths: number;
  purchaseDate: Date;
}

export interface DepreciationPeriod {
  yearMonth: string; // "YYYY-MM"
  amount: Decimal;
  accumulated: Decimal;
}

function ym(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * Straight-line monthly depreciation schedule. Depreciation starts in the
 * purchase month, prorated by days for the partial first month. Stops exactly
 * at the salvage value (never depreciates below it). Deterministic + pure.
 *
 * @param upTo optional "YYYY-MM" — only return periods up to and including it.
 */
export function straightLineSchedule(
  asset: DepreciableAsset,
  upTo?: string
): DepreciationPeriod[] {
  const cost = money(asset.cost);
  const salvage = money(asset.salvageValue);
  const base = sub(cost, salvage); // depreciable base
  if (base.lessThanOrEqualTo(0) || asset.usefulLifeMonths <= 0) return [];

  const fullMonthly = round2(base.dividedBy(asset.usefulLifeMonths));

  const periods: DepreciationPeriod[] = [];
  let accumulated = ZERO;
  const start = asset.purchaseDate;
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth(); // 0-based
  const purchaseDay = start.getUTCDate();
  let first = true;

  // Cap iterations generously (life + 2 for the proration spillover).
  const maxMonths = asset.usefulLifeMonths + 2;
  for (let i = 0; i < maxMonths; i++) {
    if (accumulated.greaterThanOrEqualTo(base)) break;

    let amount = fullMonthly;
    if (first) {
      const dim = daysInMonth(year, month);
      const factor = new Decimal(dim - purchaseDay + 1).dividedBy(dim);
      amount = round2(fullMonthly.times(factor));
      first = false;
    }

    // clamp to remaining depreciable base (salvage stop)
    const remaining = sub(base, accumulated);
    if (amount.greaterThan(remaining)) amount = round2(remaining);
    if (amount.lessThanOrEqualTo(0)) break;

    accumulated = add(accumulated, amount);
    const key = ym(new Date(Date.UTC(year, month, 1)));
    periods.push({ yearMonth: key, amount, accumulated: round2(accumulated) });

    if (upTo && key === upTo) break;

    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  if (upTo) return periods.filter((p) => p.yearMonth <= upTo);
  return periods;
}

/** Net book value after a set of posted periods. */
export function netBookValue(cost: Decimal.Value, accumulated: Decimal.Value): Decimal {
  return round2(sub(cost, accumulated));
}

export { ym as yearMonthOf };
