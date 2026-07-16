import Link from "next/link";
import { notFound } from "next/navigation";
import ReportToolbar from "@/components/ReportToolbar";
import { getActiveCompany } from "@/lib/company";
import { formatMoney } from "@/lib/money";
import { tenantStatement } from "@/lib/reports";
import { prisma } from "@/lib/prisma";
import { getSupplierStatementLines } from "@/lib/services/payables";

export const dynamic = "force-dynamic";

export default async function SupplierStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const { id } = await params;
  const sp = await searchParams;
  const supplier = await prisma.supplier.findFirst({ where: { id, companyId: company.id } });
  if (!supplier) notFound();

  const now = new Date();
  const from = sp.from ? new Date(sp.from + "T00:00:00Z") : undefined;
  const to = new Date((sp.to || now.toISOString().slice(0, 10)) + "T23:59:59Z");
  const st = tenantStatement(await getSupplierStatementLines(company.id, id), from, to);

  const csv: string[][] = [
    [`Supplier statement — ${supplier.name}`],
    [company.name, company.registrationNo ? `Reg: ${company.registrationNo}` : ""],
    [],
    ["Date", "Description", "Bill", "Payment", "Balance"],
    ["", "Opening balance", "", "", st.opening.toFixed(2)],
    ...st.rows.map((r) => [r.date, r.description, r.charge.toFixed(2), r.payment.toFixed(2), r.balance.toFixed(2)]),
    ["", "Balance owed", st.totalCharges.toFixed(2), st.totalPayments.toFixed(2), st.closing.toFixed(2)],
  ];

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between flex-wrap gap-2 no-print">
        <Link href={`/suppliers/${id}`} className="text-sm text-primary">
          ← Supplier
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
          <ReportToolbar rows={csv} filename={`supplier-statement-${supplier.name.replace(/\s+/g, "-")}.csv`} />
        </div>
      </div>

      <div className="card p-6">
        <div className="flex items-start justify-between border-b border-line pb-3 mb-4">
          <div>
            <h1 className="text-xl font-bold text-primary">{company.name}</h1>
            {company.registrationNo && <p className="text-xs text-muted">Reg. No. {company.registrationNo}</p>}
          </div>
          <div className="text-right text-sm">
            <div className="font-semibold">Supplier Statement</div>
            <div className="text-muted">as at {to.toISOString().slice(0, 10)}</div>
          </div>
        </div>

        <div className="text-sm mb-4">
          <div className="text-muted">Supplier</div>
          <div className="font-medium">{supplier.name}</div>
          {supplier.email && <div className="text-muted">{supplier.email}</div>}
        </div>

        <table className="w-full">
          <thead>
            <tr>
              <th className="th">Date</th>
              <th className="th">Description</th>
              <th className="th text-right">Bill</th>
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
      </div>
    </div>
  );
}
