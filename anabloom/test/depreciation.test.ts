import { describe, expect, it } from "vitest";
import { straightLineSchedule } from "@/lib/depreciation";
import { add, ZERO } from "@/lib/money";

function totalOf(periods: { amount: any }[]) {
  return periods.reduce((acc, p) => add(acc, p.amount), ZERO);
}

describe("straight-line depreciation", () => {
  it("depreciates exactly down to the salvage value and stops", () => {
    const periods = straightLineSchedule({
      cost: 10000,
      salvageValue: 1000,
      usefulLifeMonths: 9,
      purchaseDate: new Date(Date.UTC(2026, 0, 1)), // 1 Jan (full first month)
    });
    // depreciable base = 9000, monthly = 1000, exactly 9 months
    expect(periods.length).toBe(9);
    expect(totalOf(periods).toFixed(2)).toBe("9000.00");
    const last = periods[periods.length - 1];
    expect(last.accumulated.toFixed(2)).toBe("9000.00");
    // never below salvage
    expect(totalOf(periods).lessThanOrEqualTo(9000)).toBe(true);
  });

  it("prorates the first month by days when purchased mid-month", () => {
    const periods = straightLineSchedule({
      cost: 12000,
      salvageValue: 0,
      usefulLifeMonths: 36,
      purchaseDate: new Date(Date.UTC(2026, 0, 16)), // 16 Jan
    });
    const fullMonthly = 12000 / 36; // 333.33
    // first month is partial (16..31 => 16/31 of a month) => less than full
    expect(periods[0].amount.toNumber()).toBeLessThan(fullMonthly);
    expect(periods[1].amount.toFixed(2)).toBe(fullMonthly.toFixed(2));
    // total still equals the depreciable base
    expect(totalOf(periods).toFixed(2)).toBe("12000.00");
  });

  it("supports an up-to cutoff (idempotent generation window)", () => {
    const periods = straightLineSchedule(
      {
        cost: 3600,
        salvageValue: 0,
        usefulLifeMonths: 36,
        purchaseDate: new Date(Date.UTC(2026, 0, 1)),
      },
      "2026-03"
    );
    expect(periods.map((p) => p.yearMonth)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("returns nothing when there is no depreciable base", () => {
    expect(
      straightLineSchedule({
        cost: 5000,
        salvageValue: 5000,
        usefulLifeMonths: 12,
        purchaseDate: new Date(Date.UTC(2026, 0, 1)),
      })
    ).toEqual([]);
  });
});
