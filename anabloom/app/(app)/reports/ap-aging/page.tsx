import Link from "next/link";
import ReportToolbar from "@/components/ReportToolbar";
import { getActiveCompany } from "@/lib/company";
import { formatMoney } from "@/lib/money";
import { apAging } from "@/lib/reports";
import { getApAgingData } from "@/lib/services/payables";

export const dynamic = "force-dynamic";

export default async function ApAgingPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const sp = await searchParams;
  const asOf = sp.asOf ? new Date(sp.asOf + "T23:59:59Z") : new Date();
  const report = apAging(await getApAgingData(company.id), asOf);

  const csv = [
    ["Supplier", "0-30", "31-60", "61-90", "90+", "Total"],
    ...report.rows.map((r) => [r.supplierName, r.b0_30.toFixed(2), r.b31_60.toFixed(2), r.b61_90.toFixed(2), r.b90plus.toFixed(2), r.total.toFixed(2)]),
    ["TOTAL", report.totals.b0_30.toFixed(2), report.totals.b31_60.toFixed(2), report.totals.b61_90.toFixed(2), report.totals.b90plus.toFixed(2), report.totals.total.toFixed(2)],
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/reports" className="text-sm text-primary no-print">
            ← Reports
          </Link>
          <h1 className="text-2xl font-bold">AP Aging</h1>
          <p className="text-sm text-muted">{company.name}</p>
        </div>
        <div className="flex items-end gap-2">
          <form method="get" className="flex items-end gap-2 no-print">
            <div>
              <label className="label">As of</label>
              <input className="input" type="date" name="asOf" defaultValue={asOf.toISOString().slice(0, 10)} />
            </div>
            <button className="btn-primary">Update</button>
          </form>
          <ReportToolbar rows={csv} filename="ap-aging.csv" />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[600px]">
          <thead>
            <tr>
              <th className="th">Supplier</th>
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
                <td className="td text-muted" colSpan={6}>
                  No outstanding payables. 🎉
                </td>
              </tr>
            )}
            {report.rows.map((r) => {
              const overdue = Number(r.b31_60) + Number(r.b61_90) + Number(r.b90plus) > 0;
              return (
                <tr key={r.supplierId} className={overdue ? "bg-expense/5" : ""}>
                  <td className="td">{r.supplierName}</td>
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
              <td className="td">Total</td>
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
