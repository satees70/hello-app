import Link from "next/link";
import ReportToolbar from "@/components/ReportToolbar";
import { formatMoney } from "@/lib/money";
import { groupProfitAndLoss } from "@/lib/reports";
import { getUser } from "@/lib/session";
import { getCompanyLedgers } from "@/lib/services/group";

export const dynamic = "force-dynamic";

export default async function GroupPL({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const user = await getUser();
  const sp = await searchParams;
  const now = new Date();
  const from = new Date((sp.from || `${now.getUTCFullYear()}-01-01`) + "T00:00:00Z");
  const to = new Date((sp.to || now.toISOString().slice(0, 10)) + "T23:59:59Z");

  const ledgers = await getCompanyLedgers(user.id);
  const sym = ledgers[0]?.currency || "RM";
  const group = groupProfitAndLoss(ledgers, from, to);

  // union of account codes for income and expenses
  const incomeCodes = new Map<string, string>();
  const expenseCodes = new Map<string, string>();
  for (const col of group.columns) {
    for (const r of col.pl.income) incomeCodes.set(r.code, r.name);
    for (const r of col.pl.expenses) expenseCodes.set(r.code, r.name);
  }
  const amountFor = (col: (typeof group.columns)[number], code: string, kind: "income" | "expenses") =>
    Number((col.pl[kind].find((r) => r.code === code)?.amount ?? 0));

  const sortedIncome = [...incomeCodes.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const sortedExpense = [...expenseCodes.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const csv: string[][] = [["Account", ...group.columns.map((c) => c.companyName), "Total"]];
  for (const [code, name] of sortedIncome) {
    const amts = group.columns.map((c) => amountFor(c, code, "income"));
    csv.push([`${code} ${name}`, ...amts.map((a) => a.toFixed(2)), amts.reduce((s, a) => s + a, 0).toFixed(2)]);
  }
  csv.push(["Total income", ...group.columns.map((c) => Number(c.pl.totalIncome).toFixed(2)), group.totalIncome.toFixed(2)]);
  for (const [code, name] of sortedExpense) {
    const amts = group.columns.map((c) => amountFor(c, code, "expenses"));
    csv.push([`${code} ${name}`, ...amts.map((a) => a.toFixed(2)), amts.reduce((s, a) => s + a, 0).toFixed(2)]);
  }
  csv.push(["Total expenses", ...group.columns.map((c) => Number(c.pl.totalExpense).toFixed(2)), group.totalExpense.toFixed(2)]);
  csv.push(["Net profit", ...group.columns.map((c) => Number(c.pl.net).toFixed(2)), group.net.toFixed(2)]);

  const Cell = ({ v }: { v: number }) => <td className="td text-right num">{v === 0 ? "" : formatMoney(v, sym)}</td>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/group" className="text-sm text-primary no-print">
            ← Group overview
          </Link>
          <h1 className="text-2xl font-bold">Group Profit &amp; Loss</h1>
          <p className="text-xs text-muted">Management summary — each company files its own accounts (no inter-company eliminations).</p>
        </div>
        <ReportToolbar rows={csv} filename="group-profit-loss.csv" />
      </div>

      <form method="get" className="card p-3 flex flex-wrap gap-3 items-end no-print">
        <div>
          <label className="label">From</label>
          <input className="input" type="date" name="from" defaultValue={from.toISOString().slice(0, 10)} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input" type="date" name="to" defaultValue={to.toISOString().slice(0, 10)} />
        </div>
        <button className="btn-primary">Update</button>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr>
              <th className="th">Account</th>
              {group.columns.map((c) => (
                <th key={c.companyId} className="th text-right">
                  {c.companyName}
                </th>
              ))}
              <th className="th text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr className="bg-income/5">
              <td className="td font-semibold text-income" colSpan={group.columns.length + 2}>
                Income
              </td>
            </tr>
            {sortedIncome.map(([code, name]) => {
              const amts = group.columns.map((c) => amountFor(c, code, "income"));
              return (
                <tr key={code}>
                  <td className="td">
                    {code} {name}
                  </td>
                  {amts.map((a, i) => (
                    <Cell key={i} v={a} />
                  ))}
                  <td className="td text-right num font-medium">{formatMoney(amts.reduce((s, a) => s + a, 0), sym)}</td>
                </tr>
              );
            })}
            <tr className="font-semibold border-t border-line">
              <td className="td">Total income</td>
              {group.columns.map((c) => (
                <td key={c.companyId} className="td text-right num">
                  {formatMoney(c.pl.totalIncome, sym)}
                </td>
              ))}
              <td className="td text-right num">{formatMoney(group.totalIncome, sym)}</td>
            </tr>

            <tr className="bg-expense/5">
              <td className="td font-semibold text-expense" colSpan={group.columns.length + 2}>
                Expenses
              </td>
            </tr>
            {sortedExpense.map(([code, name]) => {
              const amts = group.columns.map((c) => amountFor(c, code, "expenses"));
              return (
                <tr key={code}>
                  <td className="td">
                    {code} {name}
                  </td>
                  {amts.map((a, i) => (
                    <Cell key={i} v={a} />
                  ))}
                  <td className="td text-right num font-medium">{formatMoney(amts.reduce((s, a) => s + a, 0), sym)}</td>
                </tr>
              );
            })}
            <tr className="font-semibold border-t border-line">
              <td className="td">Total expenses</td>
              {group.columns.map((c) => (
                <td key={c.companyId} className="td text-right num">
                  {formatMoney(c.pl.totalExpense, sym)}
                </td>
              ))}
              <td className="td text-right num">{formatMoney(group.totalExpense, sym)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr className="font-bold border-t-2 border-ink">
              <td className="td">Net profit</td>
              {group.columns.map((c) => (
                <td key={c.companyId} className={`td text-right num ${c.pl.net.isNegative() ? "text-expense" : ""}`}>
                  {formatMoney(c.pl.net, sym)}
                </td>
              ))}
              <td className={`td text-right num ${group.net.isNegative() ? "text-expense" : "text-income"}`}>{formatMoney(group.net, sym)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
