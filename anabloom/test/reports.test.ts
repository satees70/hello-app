import { describe, expect, it } from "vitest";
import { buildPosting, PostingInput } from "@/lib/posting";
import { CHART_OF_ACCOUNTS, accountTypeForCode } from "@/lib/accounts";
import { balanceSheet, generalLedger, GLInputLine, groupProfitAndLoss, LedgerLine, profitAndLoss, profitAndLossByMonth, tenantStatement, trialBalance } from "@/lib/reports";
import { sub } from "@/lib/money";

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

describe("General Ledger", () => {
  const glLines: GLInputLine[] = book.map((l) => ({
    accountCode: l.accountCode,
    accountName: l.accountName,
    accountType: l.accountType,
    date: l.date,
    description: "entry",
    propertyId: l.propertyId,
    propertyName: l.propertyId ?? null,
    debit: l.debit,
    credit: l.credit,
  }));

  it("opening + movements === closing for every account (natural sign)", () => {
    const gl = generalLedger(glLines, { from: new Date("2026-02-01"), to: new Date("2026-12-31") });
    for (const a of gl) {
      const natural = a.type === "ASSET" || a.type === "EXPENSE" ? sub(a.totalDebit, a.totalCredit) : sub(a.totalCredit, a.totalDebit);
      expect(a.opening.plus(natural).toFixed(2)).toBe(a.closing.toFixed(2));
    }
  });

  it("each account's GL closing equals its Trial Balance figure for the same date", () => {
    const asOf = new Date("2026-12-31");
    const tb = trialBalance(book, asOf);
    const gl = generalLedger(glLines, { to: asOf });
    for (const a of gl) {
      const row = tb.rows.find((r) => r.code === a.code);
      const tbFigure = row ? row.debit.plus(row.credit) : sub(0, 0);
      expect(a.closing.abs().toFixed(2)).toBe(tbFigure.toFixed(2));
    }
  });

  it("single-account selection returns just that account", () => {
    const gl = generalLedger(glLines, { accountCode: "4000" });
    expect(gl.length).toBe(1);
    expect(gl[0].code).toBe("4000");
  });
});

describe("Tenant statement", () => {
  it("running balance ends at the amount owed (charges − payments)", () => {
    const st = tenantStatement([
      { date: new Date("2026-03-01"), description: "Rent invoiced", debit: 1500, credit: 0 },
      { date: new Date("2026-03-15"), description: "Payment", debit: 0, credit: 1000 },
      { date: new Date("2026-04-01"), description: "Rent invoiced", debit: 1500, credit: 0 },
    ]);
    expect(st.opening.toFixed(2)).toBe("0.00");
    expect(st.totalCharges.toFixed(2)).toBe("3000.00");
    expect(st.totalPayments.toFixed(2)).toBe("1000.00");
    expect(st.closing.toFixed(2)).toBe("2000.00");
    expect(st.rows[st.rows.length - 1].balance.toFixed(2)).toBe("2000.00");
  });

  it("computes an opening balance from charges before the range start", () => {
    const lines = [
      { date: new Date("2026-01-10"), description: "Old charge", debit: 500, credit: 0 },
      { date: new Date("2026-03-01"), description: "Rent", debit: 1500, credit: 0 },
    ];
    const st = tenantStatement(lines, new Date("2026-02-01"), new Date("2026-03-31"));
    expect(st.opening.toFixed(2)).toBe("500.00");
    expect(st.closing.toFixed(2)).toBe("2000.00");
  });
});

describe("Group P&L", () => {
  const coA = ledgerFrom([
    { sourceType: "RENT_RECEIVED", amount: 1000, date: "2026-02-01" },
    { sourceType: "EXPENSE_PAID", amount: 200, expenseAccountCode: "5100", date: "2026-02-10" },
  ]);
  const coB = ledgerFrom([
    { sourceType: "RENT_RECEIVED", amount: 3000, date: "2026-02-01" },
    { sourceType: "EXPENSE_PAID", amount: 500, expenseAccountCode: "5000", date: "2026-02-15" },
  ]);

  it("group total equals the sum of the per-company P&Ls", () => {
    const group = groupProfitAndLoss([
      { companyId: "A", companyName: "Co A", lines: coA },
      { companyId: "B", companyName: "Co B", lines: coB },
    ]);
    const perCompanySumIncome = group.columns.reduce((s, c) => s + Number(c.pl.totalIncome), 0);
    const perCompanySumExpense = group.columns.reduce((s, c) => s + Number(c.pl.totalExpense), 0);
    const perCompanySumNet = group.columns.reduce((s, c) => s + Number(c.pl.net), 0);

    expect(Number(group.totalIncome)).toBe(perCompanySumIncome);
    expect(Number(group.totalExpense)).toBe(perCompanySumExpense);
    expect(Number(group.net)).toBe(perCompanySumNet);
    // sanity: 4000 income - 700 expense = 3300 net
    expect(group.totalIncome.toFixed(2)).toBe("4000.00");
    expect(group.net.toFixed(2)).toBe("3300.00");
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
