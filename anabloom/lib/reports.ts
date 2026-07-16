import Decimal from "decimal.js";
import { AccountType, NORMAL_BALANCE } from "./enums";
import { add, money, round2, sub, ZERO } from "./money";

// A flattened journal line joined with its account + entry metadata.
export interface LedgerLine {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debit: Decimal.Value;
  credit: Decimal.Value;
  date: Date;
  propertyId?: string | null;
}

function inRange(d: Date, from?: Date, to?: Date): boolean {
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

interface AccountAgg {
  code: string;
  name: string;
  type: AccountType;
  debit: Decimal;
  credit: Decimal;
}

function aggregate(
  lines: LedgerLine[],
  opts: { from?: Date; to?: Date; propertyId?: string } = {}
): Map<string, AccountAgg> {
  const map = new Map<string, AccountAgg>();
  for (const l of lines) {
    if (!inRange(l.date, opts.from, opts.to)) continue;
    if (opts.propertyId && l.propertyId !== opts.propertyId) continue;
    let a = map.get(l.accountCode);
    if (!a) {
      a = { code: l.accountCode, name: l.accountName, type: l.accountType, debit: ZERO, credit: ZERO };
      map.set(l.accountCode, a);
    }
    a.debit = add(a.debit, l.debit);
    a.credit = add(a.credit, l.credit);
  }
  return map;
}

// net debit balance (debit - credit); positive => debit side.
function netDebit(a: AccountAgg): Decimal {
  return sub(a.debit, a.credit);
}

// ---------- Trial Balance (as-of date) ----------
export interface TrialBalanceRow {
  code: string;
  name: string;
  type: AccountType;
  debit: Decimal;
  credit: Decimal;
}
export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebit: Decimal;
  totalCredit: Decimal;
  balanced: boolean;
}

export function trialBalance(lines: LedgerLine[], asOf?: Date): TrialBalance {
  const map = aggregate(lines, { to: asOf });
  const rows: TrialBalanceRow[] = [];
  let totalDebit = ZERO;
  let totalCredit = ZERO;
  for (const a of [...map.values()].sort((x, y) => x.code.localeCompare(y.code))) {
    const net = round2(netDebit(a));
    if (net.isZero()) continue; // only accounts with activity/balance
    const debit = net.isPositive() ? net : ZERO;
    const credit = net.isNegative() ? net.abs() : ZERO;
    rows.push({ code: a.code, name: a.name, type: a.type, debit, credit });
    totalDebit = add(totalDebit, debit);
    totalCredit = add(totalCredit, credit);
  }
  return {
    rows,
    totalDebit: round2(totalDebit),
    totalCredit: round2(totalCredit),
    balanced: round2(totalDebit).equals(round2(totalCredit)),
  };
}

// ---------- Profit & Loss (date range, optional property) ----------
export interface PLRow {
  code: string;
  name: string;
  amount: Decimal;
}
export interface ProfitAndLoss {
  income: PLRow[];
  totalIncome: Decimal;
  expenses: PLRow[];
  totalExpense: Decimal;
  net: Decimal;
}

export function profitAndLoss(
  lines: LedgerLine[],
  from?: Date,
  to?: Date,
  propertyId?: string
): ProfitAndLoss {
  const map = aggregate(lines, { from, to, propertyId });
  const income: PLRow[] = [];
  const expenses: PLRow[] = [];
  let totalIncome = ZERO;
  let totalExpense = ZERO;
  for (const a of [...map.values()].sort((x, y) => x.code.localeCompare(y.code))) {
    if (a.type === "INCOME") {
      const amt = round2(sub(a.credit, a.debit)); // credit-normal
      if (amt.isZero()) continue;
      income.push({ code: a.code, name: a.name, amount: amt });
      totalIncome = add(totalIncome, amt);
    } else if (a.type === "EXPENSE") {
      const amt = round2(sub(a.debit, a.credit)); // debit-normal
      if (amt.isZero()) continue;
      expenses.push({ code: a.code, name: a.name, amount: amt });
      totalExpense = add(totalExpense, amt);
    }
  }
  return {
    income,
    totalIncome: round2(totalIncome),
    expenses,
    totalExpense: round2(totalExpense),
    net: round2(sub(totalIncome, totalExpense)),
  };
}

// Net profit for a period (used for retained earnings).
export function netIncome(lines: LedgerLine[], from?: Date, to?: Date, propertyId?: string): Decimal {
  return profitAndLoss(lines, from, to, propertyId).net;
}

// ---------- Profit & Loss, month-by-month columns ----------
export interface PLMonthlyRow {
  code: string;
  name: string;
  amounts: Decimal[]; // one per month
  total: Decimal;
}
export interface ProfitAndLossMonthly {
  months: string[]; // "YYYY-MM"
  income: PLMonthlyRow[];
  expenses: PLMonthlyRow[];
  incomeTotals: Decimal[];
  expenseTotals: Decimal[];
  netTotals: Decimal[];
  grandIncome: Decimal;
  grandExpense: Decimal;
  grandNet: Decimal;
}

function monthsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  const endY = to.getUTCFullYear();
  const endM = to.getUTCMonth();
  for (let guard = 0; guard < 600; guard++) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    if (y === endY && m === endM) break;
    if (y > endY || (y === endY && m > endM)) break;
    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

export function profitAndLossByMonth(
  lines: LedgerLine[],
  from: Date,
  to: Date,
  propertyId?: string
): ProfitAndLossMonthly {
  const months = monthsBetween(from, to);
  const incomeMap = new Map<string, PLMonthlyRow>();
  const expenseMap = new Map<string, PLMonthlyRow>();

  months.forEach((ym, i) => {
    const [y, mo] = ym.split("-").map(Number);
    const mFrom = new Date(Date.UTC(y, mo - 1, 1));
    const mTo = new Date(Date.UTC(y, mo, 0, 23, 59, 59));
    const pl = profitAndLoss(lines, mFrom, mTo, propertyId);
    for (const r of pl.income) {
      let row = incomeMap.get(r.code);
      if (!row) {
        row = { code: r.code, name: r.name, amounts: months.map(() => ZERO), total: ZERO };
        incomeMap.set(r.code, row);
      }
      row.amounts[i] = r.amount;
      row.total = add(row.total, r.amount);
    }
    for (const r of pl.expenses) {
      let row = expenseMap.get(r.code);
      if (!row) {
        row = { code: r.code, name: r.name, amounts: months.map(() => ZERO), total: ZERO };
        expenseMap.set(r.code, row);
      }
      row.amounts[i] = r.amount;
      row.total = add(row.total, r.amount);
    }
  });

  const income = [...incomeMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  const expenses = [...expenseMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  const incomeTotals = months.map((_, i) => round2(income.reduce((s, r) => add(s, r.amounts[i]), ZERO)));
  const expenseTotals = months.map((_, i) => round2(expenses.reduce((s, r) => add(s, r.amounts[i]), ZERO)));
  const netTotals = months.map((_, i) => round2(sub(incomeTotals[i], expenseTotals[i])));
  const grandIncome = round2(incomeTotals.reduce((s, x) => add(s, x), ZERO));
  const grandExpense = round2(expenseTotals.reduce((s, x) => add(s, x), ZERO));

  return {
    months,
    income,
    expenses,
    incomeTotals,
    expenseTotals,
    netTotals,
    grandIncome,
    grandExpense,
    grandNet: round2(sub(grandIncome, grandExpense)),
  };
}

// ---------- Balance Sheet (as-of date, company-wide) ----------
export interface BSRow {
  code: string;
  name: string;
  amount: Decimal;
}
export interface BalanceSheet {
  assets: BSRow[];
  totalAssets: Decimal;
  liabilities: BSRow[];
  totalLiabilities: Decimal;
  equity: BSRow[];
  totalEquity: Decimal;
  retainedEarnings: Decimal;
  balanced: boolean;
}

const RETAINED_CODE = "3900";

export function balanceSheet(lines: LedgerLine[], asOf?: Date): BalanceSheet {
  const map = aggregate(lines, { to: asOf });
  const assets: BSRow[] = [];
  const liabilities: BSRow[] = [];
  const equity: BSRow[] = [];
  let totalAssets = ZERO;
  let totalLiabilities = ZERO;
  let totalEquity = ZERO;

  for (const a of [...map.values()].sort((x, y) => x.code.localeCompare(y.code))) {
    if (a.type === "ASSET") {
      const amt = round2(sub(a.debit, a.credit)); // includes contra 1590 (negative)
      if (amt.isZero()) continue;
      assets.push({ code: a.code, name: a.name, amount: amt });
      totalAssets = add(totalAssets, amt);
    } else if (a.type === "LIABILITY") {
      const amt = round2(sub(a.credit, a.debit));
      if (amt.isZero()) continue;
      liabilities.push({ code: a.code, name: a.name, amount: amt });
      totalLiabilities = add(totalLiabilities, amt);
    } else if (a.type === "EQUITY") {
      if (a.code === RETAINED_CODE) continue; // computed below
      const amt = round2(sub(a.credit, a.debit)); // capital +, drawings -
      if (amt.isZero()) continue;
      equity.push({ code: a.code, name: a.name, amount: amt });
      totalEquity = add(totalEquity, amt);
    }
  }

  // Retained earnings = all-time net income up to the as-of date.
  const re = round2(netIncome(lines, undefined, asOf));
  equity.push({ code: RETAINED_CODE, name: "Retained earnings", amount: re });
  totalEquity = add(totalEquity, re);

  return {
    assets,
    totalAssets: round2(totalAssets),
    liabilities,
    totalLiabilities: round2(totalLiabilities),
    equity,
    totalEquity: round2(totalEquity),
    retainedEarnings: re,
    balanced: round2(totalAssets).equals(round2(add(totalLiabilities, totalEquity))),
  };
}

// ---------- AR aging (per lease/tenant, FIFO bucketed) ----------
export interface AgingInvoice {
  leaseId: string;
  tenantName: string;
  propertyName: string;
  date: Date;
  amount: Decimal.Value; // AR debit
}
export interface AgingPayment {
  leaseId: string;
  amount: Decimal.Value; // AR credit (payment/applied)
}
export interface AgingRow {
  leaseId: string;
  tenantName: string;
  propertyName: string;
  b0_30: Decimal;
  b31_60: Decimal;
  b61_90: Decimal;
  b90plus: Decimal;
  total: Decimal;
}
export interface AgingReport {
  rows: AgingRow[];
  totals: Omit<AgingRow, "leaseId" | "tenantName" | "propertyName">;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function arAging(
  invoices: AgingInvoice[],
  payments: AgingPayment[],
  asOf: Date
): AgingReport {
  // total payments per lease
  const paid = new Map<string, Decimal>();
  for (const p of payments) paid.set(p.leaseId, add(paid.get(p.leaseId) ?? ZERO, p.amount));

  const byLease = new Map<string, AgingInvoice[]>();
  for (const inv of invoices) {
    const arr = byLease.get(inv.leaseId) ?? [];
    arr.push(inv);
    byLease.set(inv.leaseId, arr);
  }

  const rows: AgingRow[] = [];
  const totals = { b0_30: ZERO, b31_60: ZERO, b61_90: ZERO, b90plus: ZERO, total: ZERO };

  for (const [leaseId, invs] of byLease) {
    invs.sort((a, b) => a.date.getTime() - b.date.getTime());
    let remainingPayment = paid.get(leaseId) ?? ZERO;
    const row: AgingRow = {
      leaseId,
      tenantName: invs[0].tenantName,
      propertyName: invs[0].propertyName,
      b0_30: ZERO,
      b31_60: ZERO,
      b61_90: ZERO,
      b90plus: ZERO,
      total: ZERO,
    };
    for (const inv of invs) {
      let outstanding = money(inv.amount);
      // apply payments FIFO (oldest first)
      if (remainingPayment.greaterThan(0)) {
        const applied = Decimal.min(remainingPayment, outstanding);
        outstanding = outstanding.minus(applied);
        remainingPayment = remainingPayment.minus(applied);
      }
      if (outstanding.lessThanOrEqualTo(0)) continue;
      const ageDays = Math.floor((asOf.getTime() - inv.date.getTime()) / DAY_MS);
      const amt = round2(outstanding);
      if (ageDays <= 30) row.b0_30 = add(row.b0_30, amt);
      else if (ageDays <= 60) row.b31_60 = add(row.b31_60, amt);
      else if (ageDays <= 90) row.b61_90 = add(row.b61_90, amt);
      else row.b90plus = add(row.b90plus, amt);
      row.total = add(row.total, amt);
    }
    if (row.total.greaterThan(0)) {
      rows.push(row);
      totals.b0_30 = add(totals.b0_30, row.b0_30);
      totals.b31_60 = add(totals.b31_60, row.b31_60);
      totals.b61_90 = add(totals.b61_90, row.b61_90);
      totals.b90plus = add(totals.b90plus, row.b90plus);
      totals.total = add(totals.total, row.total);
    }
  }

  return { rows, totals };
}
