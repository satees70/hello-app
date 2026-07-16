import Link from "next/link";
import ReportToolbar from "@/components/ReportToolbar";
import { getActiveCompany } from "@/lib/company";
import { formatMoney } from "@/lib/money";
import { getDepositRegister } from "@/lib/services/ledgerReports";

export const dynamic = "force-dynamic";

export default async function DepositRegisterPage() {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const rows = await getDepositRegister(company.id);
  const total = rows.reduce((s, r) => s + r.held, 0);

  const csv = [
    ["Tenant", "Property", "Lease status", "Deposit held"],
    ...rows.map((r) => [r.tenantName, r.propertyName, r.status, r.held.toFixed(2)]),
    ["", "", "TOTAL", total.toFixed(2)],
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/reports" className="text-sm text-primary no-print">
            ← Reports
          </Link>
          <h1 className="text-2xl font-bold">Deposit Register</h1>
          <p className="text-sm text-muted">{company.name} — tenant deposits held (account 2000)</p>
        </div>
        <ReportToolbar rows={csv} filename="deposit-register.csv" />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[520px]">
          <thead>
            <tr>
              <th className="th">Tenant</th>
              <th className="th">Property</th>
              <th className="th">Lease</th>
              <th className="th text-right">Deposit held</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="td text-muted" colSpan={4}>
                  No deposits held.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.leaseId}>
                <td className="td">{r.tenantName}</td>
                <td className="td">{r.propertyName}</td>
                <td className="td">
                  <span className={`badge ${r.status === "ACTIVE" ? "bg-income/10 text-income" : "bg-line text-muted"}`}>{r.status}</span>
                </td>
                <td className="td text-right num">{formatMoney(r.held, sym)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold border-t-2 border-ink">
              <td className="td" colSpan={3}>
                Total deposits held
              </td>
              <td className="td text-right num">{formatMoney(total, sym)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
