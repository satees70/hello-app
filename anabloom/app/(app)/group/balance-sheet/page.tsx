import Link from "next/link";
import ReportToolbar from "@/components/ReportToolbar";
import { formatMoney } from "@/lib/money";
import { groupBalanceSheet, interCompanyBalances } from "@/lib/reports";
import { getUser } from "@/lib/session";
import { getCompanyLedgers } from "@/lib/services/group";

export const dynamic = "force-dynamic";

export default async function GroupBalanceSheet({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const user = await getUser();
  const sp = await searchParams;
  const asOf = sp.asOf ? new Date(sp.asOf + "T23:59:59Z") : new Date();

  const ledgers = await getCompanyLedgers(user.id);
  const sym = ledgers[0]?.currency || "RM";
  const group = groupBalanceSheet(ledgers, asOf);
  const interco = interCompanyBalances(ledgers, asOf);

  const rows: { label: string; get: (i: number) => number; total: number }[] = [
    { label: "Total assets", get: (i) => Number(group.columns[i].bs.totalAssets), total: Number(group.totalAssets) },
    { label: "Total liabilities", get: (i) => Number(group.columns[i].bs.totalLiabilities), total: Number(group.totalLiabilities) },
    { label: "Total equity", get: (i) => Number(group.columns[i].bs.totalEquity), total: Number(group.totalEquity) },
  ];

  const csv: string[][] = [["", ...group.columns.map((c) => c.companyName), "Combined"]];
  for (const r of rows) csv.push([r.label, ...group.columns.map((_, i) => r.get(i).toFixed(2)), r.total.toFixed(2)]);
  if (interco.rows.length) {
    csv.push([]);
    csv.push(["Inter-company account", "Company", "Balance"]);
    for (const r of interco.rows) csv.push([`${r.code} ${r.name}`, r.companyName, Number(r.amount).toFixed(2)]);
    csv.push(["Net inter-company", "", interco.net.toFixed(2)]);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/group" className="text-sm text-primary no-print">
            ← Group overview
          </Link>
          <h1 className="text-2xl font-bold">Group Balance Sheet</h1>
        </div>
        <div className="flex items-end gap-2">
          <form method="get" className="flex items-end gap-2 no-print">
            <div>
              <label className="label">As of</label>
              <input className="input" type="date" name="asOf" defaultValue={asOf.toISOString().slice(0, 10)} />
            </div>
            <button className="btn-primary">Update</button>
          </form>
          <ReportToolbar rows={csv} filename="group-balance-sheet.csv" />
        </div>
      </div>

      <div className="card p-3 text-xs text-muted">
        This is a <strong>management summary</strong>, not a statutory consolidation — there are no inter-company eliminations.
        Each company files its own accounts.
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr>
              <th className="th"></th>
              {group.columns.map((c) => (
                <th key={c.companyId} className="th text-right">
                  {c.companyName}
                </th>
              ))}
              <th className="th text-right">Combined</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="td font-medium">{r.label}</td>
                {group.columns.map((c, i) => (
                  <td key={c.companyId} className="td text-right num">
                    {formatMoney(r.get(i), sym)}
                  </td>
                ))}
                <td className="td text-right num font-semibold">{formatMoney(r.total, sym)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={`card p-4 flex justify-between items-center ${group.balanced ? "" : "border-expense"}`}>
        <span className="font-semibold">Assets = Liabilities + Equity (combined)</span>
        <span className={`font-bold ${group.balanced ? "text-income" : "text-expense"}`}>
          {formatMoney(group.totalAssets, sym)} = {formatMoney(group.totalLiabilities.plus(group.totalEquity), sym)} {group.balanced ? "✓" : "✗"}
        </span>
      </div>

      {/* Inter-company panel */}
      <div className="card p-4">
        <h2 className="font-semibold mb-2">Inter-company balances</h2>
        {interco.rows.length === 0 ? (
          <p className="text-sm text-muted">No inter-company accounts detected. Add accounts named “Inter-company …” to track money moved between your companies.</p>
        ) : (
          <>
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Company</th>
                  <th className="th">Account</th>
                  <th className="th text-right">Balance (asset + / liability −)</th>
                </tr>
              </thead>
              <tbody>
                {interco.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="td">
                      <span className="badge bg-primary/10 text-primary">{r.companyName}</span>
                    </td>
                    <td className="td">
                      {r.code} {r.name}
                    </td>
                    <td className="td text-right num">{formatMoney(r.amount, sym)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className={`mt-2 text-sm font-medium ${interco.net.isZero() ? "text-income" : "text-expense"}`}>
              Net inter-company: {formatMoney(interco.net, sym)}{" "}
              {interco.net.isZero() ? "✓ (both sides agree)" : "— mismatch: the receivable and payable sides don’t net to zero. Check both companies."}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
