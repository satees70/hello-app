import Link from "next/link";
import ReportToolbar from "@/components/ReportToolbar";
import { formatMoney } from "@/lib/money";
import { getUser } from "@/lib/session";
import { getAgingReport } from "@/lib/services/arrears";

export const dynamic = "force-dynamic";

export default async function AgingPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const user = await getUser();
  const sym = user.currency;
  const sp = await searchParams;
  const asOf = sp.asOf ? new Date(sp.asOf + "T23:59:59Z") : new Date();
  const report = await getAgingReport(user.id, asOf);

  const csv = [
    ["Tenant", "Property", "0-30", "31-60", "61-90", "90+", "Total"],
    ...report.rows.map((r) => [r.tenantName, r.propertyName, r.b0_30.toFixed(2), r.b31_60.toFixed(2), r.b61_90.toFixed(2), r.b90plus.toFixed(2), r.total.toFixed(2)]),
    ["", "TOTAL", report.totals.b0_30.toFixed(2), report.totals.b31_60.toFixed(2), report.totals.b61_90.toFixed(2), report.totals.b90plus.toFixed(2), report.totals.total.toFixed(2)],
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/reports" className="text-sm text-primary no-print">
            ← Reports
          </Link>
          <h1 className="text-2xl font-bold">AR Aging</h1>
        </div>
        <div className="flex items-end gap-2">
          <form method="get" className="flex items-end gap-2 no-print">
            <div>
              <label className="label">As of</label>
              <input className="input" type="date" name="asOf" defaultValue={asOf.toISOString().slice(0, 10)} />
            </div>
            <button className="btn-primary">Update</button>
          </form>
          <ReportToolbar rows={csv} filename="ar-aging.csv" />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr>
              <th className="th">Tenant</th>
              <th className="th">Property</th>
              <th className="th text-right">0–30</th>
              <th className="th text-right">31–60</th>
              <th className="th text-right">61–90</th>
              <th className="th text-right">90+</th>
              <th className="th text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 && (
              <tr>
                <td className="td text-muted" colSpan={7}>
                  No outstanding receivables. 🎉
                </td>
              </tr>
            )}
            {report.rows.map((r) => {
              const overdue = Number(r.b31_60) + Number(r.b61_90) + Number(r.b90plus) > 0;
              return (
                <tr key={r.leaseId} className={overdue ? "bg-expense/5" : ""}>
                  <td className="td">{r.tenantName}</td>
                  <td className="td">{r.propertyName}</td>
                  <td className="td text-right num">{formatMoney(r.b0_30, sym)}</td>
                  <td className="td text-right num">{formatMoney(r.b31_60, sym)}</td>
                  <td className="td text-right num">{formatMoney(r.b61_90, sym)}</td>
                  <td className="td text-right num text-expense">{formatMoney(r.b90plus, sym)}</td>
                  <td className="td text-right num font-semibold">{formatMoney(r.total, sym)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-bold border-t-2 border-ink">
              <td className="td" colSpan={2}>
                Total
              </td>
              <td className="td text-right num">{formatMoney(report.totals.b0_30, sym)}</td>
              <td className="td text-right num">{formatMoney(report.totals.b31_60, sym)}</td>
              <td className="td text-right num">{formatMoney(report.totals.b61_90, sym)}</td>
              <td className="td text-right num">{formatMoney(report.totals.b90plus, sym)}</td>
              <td className="td text-right num">{formatMoney(report.totals.total, sym)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
