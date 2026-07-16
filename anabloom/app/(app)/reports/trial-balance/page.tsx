import Link from "next/link";
import { Money } from "@/components/Money";
import ReportToolbar from "@/components/ReportToolbar";
import { formatMoney } from "@/lib/money";
import { trialBalance } from "@/lib/reports";
import { getActiveCompany } from "@/lib/company";
import { getLedgerLines } from "@/lib/services/ledger";

export const dynamic = "force-dynamic";

export default async function TrialBalancePage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const sp = await searchParams;
  const asOf = sp.asOf ? new Date(sp.asOf + "T23:59:59Z") : new Date();
  const tb = trialBalance(await getLedgerLines(company.id), asOf);

  const csv = [
    ["Code", "Account", "Debit", "Credit"],
    ...tb.rows.map((r) => [r.code, r.name, r.debit.toFixed(2), r.credit.toFixed(2)]),
    ["", "TOTAL", tb.totalDebit.toFixed(2), tb.totalCredit.toFixed(2)],
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/reports" className="text-sm text-primary no-print">
            ← Reports
          </Link>
          <h1 className="text-2xl font-bold">Trial Balance</h1>
        </div>
        <div className="flex items-end gap-2">
          <form method="get" className="flex items-end gap-2 no-print">
            <div>
              <label className="label">As of</label>
              <input className="input" type="date" name="asOf" defaultValue={asOf.toISOString().slice(0, 10)} />
            </div>
            <button className="btn-primary">Update</button>
          </form>
          <ReportToolbar rows={csv} filename="trial-balance.csv" />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[520px]">
          <thead>
            <tr>
              <th className="th">Code</th>
              <th className="th">Account</th>
              <th className="th text-right">Debit</th>
              <th className="th text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {tb.rows.map((r) => (
              <tr key={r.code}>
                <td className="td num">{r.code}</td>
                <td className="td">{r.name}</td>
                <td className="td text-right num">{r.debit.isZero() ? "" : formatMoney(r.debit, sym)}</td>
                <td className="td text-right num">{r.credit.isZero() ? "" : formatMoney(r.credit, sym)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold border-t-2 border-ink">
              <td className="td" colSpan={2}>
                Total
              </td>
              <td className="td text-right num">{formatMoney(tb.totalDebit, sym)}</td>
              <td className="td text-right num">{formatMoney(tb.totalCredit, sym)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className={`text-sm font-medium ${tb.balanced ? "text-income" : "text-expense"}`}>
        {tb.balanced ? "Balanced ✓" : "NOT BALANCED — this indicates a bug."}
      </div>
    </div>
  );
}
