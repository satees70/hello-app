import { describe, expect, it } from "vitest";
import { buildPosting, PostingInput } from "@/lib/posting";
import { CHART_OF_ACCOUNTS, accountTypeForCode } from "@/lib/accounts";
import { balanceSheet, LedgerLine, profitAndLoss, profitAndLossByMonth, trialBalance } from "@/lib/reports";

const NAME = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a.name]));

function ledgerFrom(
  txns: (PostingInput & { date: string; propertyId?: string })[]
): LedgerLine[] {
  const lines: LedgerLine[] = [];
  for (const t of txns) {
    for (const l of buildPosting(t)) {
      lines.push({
        accountCode: l.accountCode,
        accountName: NAME.get(l.accountCode) ?? l.accountCode,
        accountType: accountTypeForCode(l.accountCode),
        debit: l.debit,
        credit: l.credit,
        date: new Date(t.date),
        propertyId: t.propertyId ?? null,
      });
    }
  }
  return lines;
}

const book = ledgerFrom([
  { sourceType: "OWNER_CAPITAL", amount: 50000, date: "2026-01-01" },
  { sourceType: "LOAN_RECEIVED", amount: 100000, date: "2026-01-02" },
  { sourceType: "ASSET_PURCHASED", amount: 120000, assetAccountCode: "1500", fundingAccountCode: "2100", date: "2026-01-03" },
  { sourceType: "RENT_RECEIVED", amount: 1500, date: "2026-02-01", propertyId: "p1" },
  { sourceType: "RENT_RECEIVED", amount: 2000, date: "2026-02-01", propertyId: "p2" },
  { sourceType: "RENT_INVOICED", amount: 1500, date: "2026-03-01", propertyId: "p1" },
  { sourceType: "EXPENSE_PAID", amount: 300, expenseAccountCode: "5100", date: "2026-02-10", propertyId: "p1" },
  { sourceType: "EXPENSE_PAID", amount: 500, expenseAccountCode: "5000", date: "2026-02-15", propertyId: "p2" },
  { sourceType: "DEPRECIATION", amount: 1000, date: "2026-02-28" },
  { sourceType: "OWNER_DRAWINGS", amount: 800, date: "2026-03-05" },
]);

describe("Trial Balance", () => {
  it("always balances (debits == credits)", () => {
    const tb = trialBalance(book);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit.toFixed(2)).toBe(tb.totalCredit.toFixed(2));
  });
  it("puts each account balance in the correct column", () => {
    const tb = trialBalance(book);
    const cash = tb.rows.find((r) => r.code === "1000")!;
    expect(cash.debit.greaterThan(0)).toBe(true); // asset debit-normal
    const income = tb.rows.find((r) => r.code === "4000")!;
    // 1500 + 2000 received + 1500 invoiced (as-of TB includes all activity)
    expect(income.credit.toFixed(2)).toBe("5000.00");
  });
});

describe("Profit & Loss", () => {
  it("net = income - expenses over the full period", () => {
    const pl = profitAndLoss(book);
    // income: rent 3500 (received) + 1500 invoiced = 5000
    expect(pl.totalIncome.toFixed(2)).toBe("5000.00");
    // expenses: 300 + 500 + 1000 dep = 1800
    expect(pl.totalExpense.toFixed(2)).toBe("1800.00");
    expect(pl.net.toFixed(2)).toBe("3200.00");
  });
  it("filters by property", () => {
    const pl = profitAndLoss(book, undefined, undefined, "p1");
    // p1 income: 1500 received + 1500 invoiced = 3000; expenses 300
    expect(pl.totalIncome.toFixed(2)).toBe("3000.00");
    expect(pl.totalExpense.toFixed(2)).toBe("300.00");
    expect(pl.net.toFixed(2)).toBe("2700.00");
  });
  it("respects date range", () => {
    const pl = profitAndLoss(book, new Date("2026-02-01"), new Date("2026-02-28"));
    expect(pl.totalIncome.toFixed(2)).toBe("3500.00");
    expect(pl.totalExpense.toFixed(2)).toBe("1800.00");
  });
});

describe("Profit & Loss — month by month", () => {
  it("splits totals across months and sums to the period net", () => {
    const plm = profitAndLossByMonth(book, new Date("2026-02-01"), new Date("2026-03-31"));
    expect(plm.months).toEqual(["2026-02", "2026-03"]);
    // Feb: income 3500, expenses 300+500+1000=1800 -> net 1700
    expect(plm.incomeTotals[0].toFixed(2)).toBe("3500.00");
    expect(plm.expenseTotals[0].toFixed(2)).toBe("1800.00");
    expect(plm.netTotals[0].toFixed(2)).toBe("1700.00");
    // Mar: income 1500 invoiced, expenses 0 -> net 1500
    expect(plm.netTotals[1].toFixed(2)).toBe("1500.00");
    expect(plm.grandNet.toFixed(2)).toBe("3200.00");
  });
});

describe("Balance Sheet", () => {
  it("satisfies Assets = Liabilities + Equity", () => {
    const bs = balanceSheet(book);
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssets.toFixed(2)).toBe(
      bs.totalLiabilities.plus(bs.totalEquity).toFixed(2)
    );
  });
  it("retained earnings equals all-time net income", () => {
    const bs = balanceSheet(book);
    expect(bs.retainedEarnings.toFixed(2)).toBe("3200.00");
  });
  it("shows owner capital and drawings separately", () => {
    const bs = balanceSheet(book);
    const capital = bs.equity.find((r) => r.code === "3000")!;
    const drawings = bs.equity.find((r) => r.code === "3100")!;
    expect(capital.amount.toFixed(2)).toBe("50000.00");
    expect(drawings.amount.toFixed(2)).toBe("-800.00");
  });
  it("nets fixed assets down by accumulated depreciation", () => {
    const bs = balanceSheet(book);
    const accDep = bs.assets.find((r) => r.code === "1590")!;
    expect(accDep.amount.toFixed(2)).toBe("-1000.00");
  });
});
