import Link from "next/link";
import ReportToolbar from "@/components/ReportToolbar";
import { formatMoney } from "@/lib/money";
import { profitAndLoss } from "@/lib/reports";
import { prisma } from "@/lib/prisma";
import { getUser } from "@/lib/session";
import { getLedgerLines } from "@/lib/services/ledger";

export const dynamic = "force-dynamic";

export default async function ProfitLossPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; property?: string }>;
}) {
  const user = await getUser();
  const sym = user.currency;
  const sp = await searchParams;
  const now = new Date();
  const from = new Date((sp.from || `${now.getUTCFullYear()}-01-01`) + "T00:00:00Z");
  const to = new Date((sp.to || now.toISOString().slice(0, 10)) + "T23:59:59Z");
  const propertyId = sp.property || undefined;

  const [lines, properties] = await Promise.all([
    getLedgerLines(user.id),
    prisma.property.findMany({ where: { userId: user.id }, orderBy: { name: "asc" } }),
  ]);
  const pl = profitAndLoss(lines, from, to, propertyId);

  const csv = [
    ["Section", "Code", "Account", "Amount"],
    ...pl.income.map((r) => ["Income", r.code, r.name, r.amount.toFixed(2)]),
    ["", "", "Total income", pl.totalIncome.toFixed(2)],
    ...pl.expenses.map((r) => ["Expense", r.code, r.name, r.amount.toFixed(2)]),
    ["", "", "Total expenses", pl.totalExpense.toFixed(2)],
    ["", "", "Net profit", pl.net.toFixed(2)],
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/reports" className="text-sm text-primary no-print">
            ← Reports
          </Link>
          <h1 className="text-2xl font-bold">Profit &amp; Loss</h1>
        </div>
        <ReportToolbar rows={csv} filename="profit-loss.csv" />
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
        <div>
          <label className="label">Property</label>
          <select className="input" name="property" defaultValue={propertyId || ""}>
            <option value="">Consolidated</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-primary">Update</button>
      </form>

      <div className="card p-5 max-w-2xl">
        <h2 className="font-semibold text-income mb-2">Income</h2>
        <Section rows={pl.income} sym={sym} />
        <Total label="Total income" value={formatMoney(pl.totalIncome, sym)} />

        <h2 className="font-semibold text-expense mb-2 mt-5">Expenses</h2>
        <Section rows={pl.expenses} sym={sym} />
        <Total label="Total expenses" value={formatMoney(pl.totalExpense, sym)} />

        <div className="border-t-2 border-ink mt-5 pt-3 flex justify-between font-bold text-lg">
          <span>Net profit</span>
          <span className={`num ${pl.net.isNegative() ? "text-expense" : "text-income"}`}>{formatMoney(pl.net, sym)}</span>
        </div>
      </div>
    </div>
  );
}

function Section({ rows, sym }: { rows: { code: string; name: string; amount: import("decimal.js").default }[]; sym: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">None</p>;
  return (
    <table className="w-full">
      <tbody>
        {rows.map((r) => (
          <tr key={r.code}>
            <td className="py-1 text-sm">
              {r.code} {r.name}
            </td>
            <td className="py-1 text-right num text-sm">{formatMoney(r.amount, sym)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-t border-line mt-1 pt-1 font-semibold text-sm">
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}
