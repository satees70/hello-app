import Link from "next/link";
import { notFound } from "next/navigation";
import ReportToolbar from "@/components/ReportToolbar";
import { getActiveCompany } from "@/lib/company";
import { formatMoney } from "@/lib/money";
import { tenantStatement } from "@/lib/reports";
import { prisma } from "@/lib/prisma";
import { getTenantStatementLines } from "@/lib/services/ledgerReports";

export const dynamic = "force-dynamic";

export default async function TenantStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ leaseId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const { leaseId } = await params;
  const sp = await searchParams;

  const lease = await prisma.lease.findFirst({
    where: { id: leaseId, companyId: company.id },
    include: { tenant: true, property: true },
  });
  if (!lease) notFound();

  const now = new Date();
  const from = sp.from ? new Date(sp.from + "T00:00:00Z") : undefined;
  const to = new Date((sp.to || now.toISOString().slice(0, 10)) + "T23:59:59Z");

  const arLines = await getTenantStatementLines(company.id, leaseId);
  const st = tenantStatement(arLines, from, to);

  const csv: string[][] = [
    [`Statement of account — ${lease.tenant.name}`],
    [company.name, company.registrationNo ? `Reg: ${company.registrationNo}` : ""],
    [],
    ["Date", "Description", "Charge", "Payment", "Balance"],
    ["", "Opening balance", "", "", st.opening.toFixed(2)],
    ...st.rows.map((r) => [r.date, r.description, r.charge.toFixed(2), r.payment.toFixed(2), r.balance.toFixed(2)]),
    ["", "Balance owed", st.totalCharges.toFixed(2), st.totalPayments.toFixed(2), st.closing.toFixed(2)],
  ];

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between flex-wrap gap-2 no-print">
        <Link href={`/tenants/${leaseId}`} className="text-sm text-primary">
          ← Lease
        </Link>
        <div className="flex items-end gap-2">
          <form method="get" className="flex items-end gap-2">
            <div>
              <label className="label">From</label>
              <input className="input" type="date" name="from" defaultValue={sp.from || ""} />
            </div>
            <div>
              <label className="label">To</label>
              <input className="input" type="date" name="to" defaultValue={to.toISOString().slice(0, 10)} />
            </div>
            <button className="btn-primary">Update</button>
          </form>
          <ReportToolbar rows={csv} filename={`statement-${lease.tenant.name.replace(/\s+/g, "-")}.csv`} />
        </div>
      </div>

      <div className="card p-6">
        {/* Print header with company identity */}
        <div className="flex items-start justify-between border-b border-line pb-3 mb-4">
          <div>
            <h1 className="text-xl font-bold text-primary">{company.name}</h1>
            {company.registrationNo && <p className="text-xs text-muted">Reg. No. {company.registrationNo}</p>}
          </div>
          <div className="text-right text-sm">
            <div className="font-semibold">Statement of Account</div>
            <div className="text-muted">as at {to.toISOString().slice(0, 10)}</div>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-2 text-sm mb-4">
          <div>
            <div className="text-muted">Tenant</div>
            <div className="font-medium">{lease.tenant.name}</div>
            {lease.tenant.phone && <div className="text-muted">{lease.tenant.phone}</div>}
          </div>
          <div className="sm:text-right">
            <div className="text-muted">Property</div>
            <div className="font-medium">{lease.property.name}</div>
          </div>
        </div>

        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Date</th>
              <th className="th">Description</th>
              <th className="th text-right">Charge</th>
              <th className="th text-right">Payment</th>
              <th className="th text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="text-muted">
              <td className="td" colSpan={4}>
                Opening balance
              </td>
              <td className="td text-right num">{formatMoney(st.opening, sym)}</td>
            </tr>
            {st.rows.map((r, i) => (
              <tr key={i}>
                <td className="td whitespace-nowrap">{r.date}</td>
                <td className="td">{r.description}</td>
                <td className="td text-right num">{r.charge.isZero() ? "" : formatMoney(r.charge, sym)}</td>
                <td className="td text-right num">{r.payment.isZero() ? "" : formatMoney(r.payment, sym)}</td>
                <td className="td text-right num">{formatMoney(r.balance, sym)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold border-t-2 border-ink">
              <td className="td" colSpan={4}>
                Balance owed
              </td>
              <td className="td text-right num">{formatMoney(st.closing, sym)}</td>
            </tr>
          </tfoot>
        </table>

        <p className="text-xs text-muted mt-4">
          {st.closing.greaterThan(0)
            ? `Amount currently owed: ${formatMoney(st.closing, sym)}. Please settle at your earliest convenience.`
            : "No outstanding balance. Thank you."}
        </p>
      </div>
    </div>
  );
}
