import Link from "next/link";
import ReportToolbar from "@/components/ReportToolbar";
import { formatMoney } from "@/lib/money";
import { balanceSheet } from "@/lib/reports";
import { getActiveCompany } from "@/lib/company";
import { getLedgerLines } from "@/lib/services/ledger";

export const dynamic = "force-dynamic";

export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const sp = await searchParams;
  const asOf = sp.asOf ? new Date(sp.asOf + "T23:59:59Z") : new Date();
  const bs = balanceSheet(await getLedgerLines(company.id), asOf);

  const csv = [
    ["Section", "Code", "Account", "Amount"],
    ...bs.assets.map((r) => ["Asset", r.code, r.name, r.amount.toFixed(2)]),
    ["", "", "Total assets", bs.totalAssets.toFixed(2)],
    ...bs.liabilities.map((r) => ["Liability", r.code, r.name, r.amount.toFixed(2)]),
    ["", "", "Total liabilities", bs.totalLiabilities.toFixed(2)],
    ...bs.equity.map((r) => ["Equity", r.code, r.name, r.amount.toFixed(2)]),
    ["", "", "Total equity", bs.totalEquity.toFixed(2)],
  ];

  const Sec = ({ title, rows, total }: { title: string; rows: typeof bs.assets; total: import("decimal.js").default }) => (
    <div className="card p-5">
      <h2 className="font-semibold mb-2">{title}</h2>
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
      <div className="flex justify-between border-t-2 border-ink mt-2 pt-2 font-bold">
        <span>Total {title.toLowerCase()}</span>
        <span className="num">{formatMoney(total, sym)}</span>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/reports" className="text-sm text-primary no-print">
            ← Reports
          </Link>
          <h1 className="text-2xl font-bold">Balance Sheet</h1>
        </div>
        <div className="flex items-end gap-2">
          <form method="get" className="flex items-end gap-2 no-print">
            <div>
              <label className="label">As of</label>
              <input className="input" type="date" name="asOf" defaultValue={asOf.toISOString().slice(0, 10)} />
            </div>
            <button className="btn-primary">Update</button>
          </form>
          <ReportToolbar rows={csv} filename="balance-sheet.csv" />
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Sec title="Assets" rows={bs.assets} total={bs.totalAssets} />
        <div className="space-y-4">
          <Sec title="Liabilities" rows={bs.liabilities} total={bs.totalLiabilities} />
          <Sec title="Equity" rows={bs.equity} total={bs.totalEquity} />
        </div>
      </div>

      <div className={`card p-4 flex justify-between items-center ${bs.balanced ? "" : "border-expense"}`}>
        <span className="font-semibold">Assets = Liabilities + Equity</span>
        <span className={`font-bold ${bs.balanced ? "text-income" : "text-expense"}`}>
          {formatMoney(bs.totalAssets, sym)} = {formatMoney(bs.totalLiabilities.plus(bs.totalEquity), sym)} {bs.balanced ? "✓" : "✗ (bug)"}
        </span>
      </div>
    </div>
  );
}
