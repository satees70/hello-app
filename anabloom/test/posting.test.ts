import { describe, expect, it } from "vitest";
import { buildPosting, PostingError, validateLines } from "@/lib/posting";
import { SourceType } from "@/lib/enums";
import { add, ZERO } from "@/lib/money";

function totals(lines: { debit: any; credit: any }[]) {
  let d = ZERO;
  let c = ZERO;
  for (const l of lines) {
    d = add(d, l.debit);
    c = add(c, l.credit);
  }
  return { d: d.toFixed(2), c: c.toFixed(2) };
}

function codes(lines: { accountCode: string; debit: any; credit: any }[]) {
  return lines.map((l) => ({
    code: l.accountCode,
    debit: l.debit.toFixed(2),
    credit: l.credit.toFixed(2),
  }));
}

describe("posting engine — every transaction type balances", () => {
  const cases: { input: Parameters<typeof buildPosting>[0]; expect: [string, string, string][] }[] = [
    {
      input: { sourceType: "RENT_RECEIVED", amount: 1500 },
      expect: [["1000", "1500.00", "0.00"], ["4000", "0.00", "1500.00"]],
    },
    {
      input: { sourceType: "OTHER_INCOME_RECEIVED", amount: 200, incomeAccountCode: "4200" },
      expect: [["1000", "200.00", "0.00"], ["4200", "0.00", "200.00"]],
    },
    {
      input: { sourceType: "RENT_INVOICED", amount: 1500 },
      expect: [["1100", "1500.00", "0.00"], ["4000", "0.00", "1500.00"]],
    },
    {
      input: { sourceType: "RENT_PAYMENT", amount: 1500 },
      expect: [["1000", "1500.00", "0.00"], ["1100", "0.00", "1500.00"]],
    },
    {
      input: { sourceType: "EXPENSE_PAID", amount: 320.5, expenseAccountCode: "5100" },
      expect: [["5100", "320.50", "0.00"], ["1000", "0.00", "320.50"]],
    },
    {
      input: { sourceType: "EXPENSE_ON_CREDIT", amount: 900, expenseAccountCode: "5000" },
      expect: [["5000", "900.00", "0.00"], ["2200", "0.00", "900.00"]],
    },
    {
      input: { sourceType: "PAY_BILL", amount: 900 },
      expect: [["2200", "900.00", "0.00"], ["1000", "0.00", "900.00"]],
    },
    {
      input: { sourceType: "DEPOSIT_RECEIVED", amount: 3000 },
      expect: [["1000", "3000.00", "0.00"], ["2000", "0.00", "3000.00"]],
    },
    {
      input: { sourceType: "DEPOSIT_REFUNDED", amount: 3000 },
      expect: [["2000", "3000.00", "0.00"], ["1000", "0.00", "3000.00"]],
    },
    {
      input: { sourceType: "DEPOSIT_APPLIED", amount: 1500 },
      expect: [["2000", "1500.00", "0.00"], ["1100", "0.00", "1500.00"]],
    },
    {
      input: { sourceType: "DEPOSIT_FORFEIT", amount: 500 },
      expect: [["2000", "500.00", "0.00"], ["4900", "0.00", "500.00"]],
    },
    {
      input: { sourceType: "OWNER_CAPITAL", amount: 50000 },
      expect: [["1000", "50000.00", "0.00"], ["3000", "0.00", "50000.00"]],
    },
    {
      input: { sourceType: "OWNER_DRAWINGS", amount: 2000 },
      expect: [["3100", "2000.00", "0.00"], ["1000", "0.00", "2000.00"]],
    },
    {
      input: { sourceType: "LOAN_RECEIVED", amount: 100000 },
      expect: [["1000", "100000.00", "0.00"], ["2100", "0.00", "100000.00"]],
    },
    {
      input: { sourceType: "LOAN_REPAYMENT", principal: 800, interest: 200 },
      expect: [["2100", "800.00", "0.00"], ["5500", "200.00", "0.00"], ["1000", "0.00", "1000.00"]],
    },
    {
      input: { sourceType: "ASSET_PURCHASED", amount: 12000, assetAccountCode: "1510" },
      expect: [["1510", "12000.00", "0.00"], ["1000", "0.00", "12000.00"]],
    },
    {
      input: { sourceType: "DEPRECIATION", amount: 100 },
      expect: [["5700", "100.00", "0.00"], ["1590", "0.00", "100.00"]],
    },
  ];

  for (const c of cases) {
    it(`${c.input.sourceType} posts correctly and balances`, () => {
      const lines = buildPosting(c.input);
      const t = totals(lines);
      expect(t.d).toBe(t.c);
      expect(codes(lines)).toEqual(
        c.expect.map(([code, debit, credit]) => ({ code, debit, credit }))
      );
    });
  }
});

describe("asset disposal gain/loss", () => {
  it("posts a gain when proceeds exceed net book value", () => {
    // cost 10000, accumulated 6000 => NBV 4000, proceeds 5000 => gain 1000
    const lines = buildPosting({
      sourceType: "ASSET_DISPOSAL",
      assetAccountCode: "1520",
      disposal: { cost: 10000, accumulated: 6000, proceeds: 5000 },
    });
    const t = totals(lines);
    expect(t.d).toBe(t.c);
    const gain = lines.find((l) => l.accountCode === "4900");
    expect(gain?.credit.toFixed(2)).toBe("1000.00");
  });

  it("posts a loss when proceeds are below net book value", () => {
    // NBV 4000, proceeds 2500 => loss 1500
    const lines = buildPosting({
      sourceType: "ASSET_DISPOSAL",
      assetAccountCode: "1520",
      disposal: { cost: 10000, accumulated: 6000, proceeds: 2500 },
    });
    const t = totals(lines);
    expect(t.d).toBe(t.c);
    const loss = lines.find((l) => l.accountCode === "5900");
    expect(loss?.debit.toFixed(2)).toBe("1500.00");
  });
});

describe("manual entries", () => {
  it("accepts a balanced multi-line entry", () => {
    const lines = buildPosting({
      sourceType: "MANUAL",
      manualLines: [
        { accountCode: "5000", debit: 100, credit: 0 },
        { accountCode: "5100", debit: 50, credit: 0 },
        { accountCode: "1000", debit: 0, credit: 150 },
      ],
    });
    const t = totals(lines);
    expect(t.d).toBe("150.00");
    expect(t.c).toBe("150.00");
  });

  it("rejects an unbalanced entry", () => {
    expect(() =>
      buildPosting({
        sourceType: "MANUAL",
        manualLines: [
          { accountCode: "5000", debit: 100, credit: 0 },
          { accountCode: "1000", debit: 0, credit: 90 },
        ],
      })
    ).toThrow(PostingError);
  });

  it("rejects a line with both debit and credit", () => {
    expect(() =>
      validateLines([
        { accountCode: "1000", debit: new (require("decimal.js"))(5), credit: new (require("decimal.js"))(5) } as any,
        { accountCode: "4000", debit: new (require("decimal.js"))(0), credit: new (require("decimal.js"))(5) } as any,
      ])
    ).toThrow(PostingError);
  });
});

describe("validation guards", () => {
  it("rejects zero/negative amounts", () => {
    expect(() => buildPosting({ sourceType: "RENT_RECEIVED", amount: 0 })).toThrow(PostingError);
    expect(() => buildPosting({ sourceType: "RENT_RECEIVED", amount: -5 })).toThrow(PostingError);
  });
  it("rejects wrong account class for expense/income", () => {
    expect(() =>
      buildPosting({ sourceType: "EXPENSE_PAID", amount: 10, expenseAccountCode: "4000" })
    ).toThrow(PostingError);
    expect(() =>
      buildPosting({ sourceType: "OTHER_INCOME_RECEIVED", amount: 10, incomeAccountCode: "5000" })
    ).toThrow(PostingError);
  });
});
