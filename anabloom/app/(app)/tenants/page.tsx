import Link from "next/link";
import { Money } from "@/components/Money";
import { createLeaseAction, createTenantAction, recordRentPaymentAction } from "@/app/actions";
import { prisma } from "@/lib/prisma";
import { getActiveCompany } from "@/lib/company";
import { getAgingReport } from "@/lib/services/arrears";
import { yearMonth } from "@/lib/services/period";

export const dynamic = "force-dynamic";

export default async function TenantsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const sp = await searchParams;
  const now = new Date();
  const ym = yearMonth(now);

  const [tenants, properties, leases, aging] = await Promise.all([
    prisma.tenant.findMany({ where: { companyId: company.id }, orderBy: { name: "asc" } }),
    prisma.property.findMany({ where: { companyId: company.id }, orderBy: { name: "asc" } }),
    prisma.lease.findMany({
      where: { companyId: company.id },
      include: { tenant: true, property: true, documents: true },
      orderBy: [{ status: "asc" }, { startDate: "desc" }],
    }),
    getAgingReport(company.id, now),
  ]);

  const activeLeases = leases.filter((l) => l.status === "ACTIVE");
  const arByLease = new Map(aging.rows.map((r) => [r.leaseId, r]));

  // received this month per lease (cash debit on entries linked to lease this month)
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthEntries = await prisma.journalEntry.findMany({
    where: { companyId: company.id, leaseId: { not: null }, date: { gte: monthStart, lt: monthEnd } },
    include: { lines: { include: { account: true } } },
  });
  const receivedByLease = new Map<string, number>();
  const invoicedByLease = new Set<string>();
  for (const e of monthEntries) {
    for (const l of e.lines) {
      if ((l.account.code === "1000" || l.account.code === "1010") && Number(l.debit) > 0 && e.leaseId) {
        receivedByLease.set(e.leaseId, (receivedByLease.get(e.leaseId) ?? 0) + Number(l.debit));
      }
      if (l.account.code === "1100" && Number(l.debit) > 0 && e.leaseId) invoicedByLease.add(e.leaseId);
    }
  }

  function statusOf(leaseId: string, rent: number) {
    const ar = arByLease.get(leaseId);
    const overdue = ar ? Number(ar.b31_60) + Number(ar.b61_90) + Number(ar.b90plus) : 0;
    const received = receivedByLease.get(leaseId) ?? 0;
    if (overdue > 0) return { label: "Overdue", cls: "bg-expense/10 text-expense" };
    if (received >= rent && rent > 0) return { label: "Paid", cls: "bg-income/10 text-income" };
    if (received > 0) return { label: "Partially paid", cls: "bg-amber-100 text-amber-700" };
    if (invoicedByLease.has(leaseId) || (ar && Number(ar.total) > 0)) return { label: "Invoiced", cls: "bg-primary/10 text-primary" };
    return { label: "—", cls: "bg-line text-muted" };
  }

  const in90 = new Date(now.getTime() + 90 * 86400000);
  const filtered = leases.filter((l) => {
    if (sp.status === "expiring") return l.status === "ACTIVE" && l.endDate && l.endDate <= in90 && l.endDate >= now;
    if (sp.status === "expired") return l.endDate && l.endDate < now;
    if (sp.status === "mtm") return l.status === "ACTIVE" && !l.endDate;
    return true;
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tenants &amp; Leases</h1>

      {/* Rent roll */}
      <div className="card">
        <div className="p-4 border-b border-line flex items-center justify-between">
          <h2 className="font-semibold">Rent roll — {ym}</h2>
          <Link href="/reports/aging" className="text-primary text-sm no-print">
            AR aging →
          </Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                <th className="th">Tenant</th>
                <th className="th">Property</th>
                <th className="th text-right">Rent</th>
                <th className="th text-right">Outstanding</th>
                <th className="th">Status</th>
                <th className="th no-print"></th>
              </tr>
            </thead>
            <tbody>
              {activeLeases.length === 0 && (
                <tr>
                  <td className="td text-muted" colSpan={6}>
                    No active leases.
                  </td>
                </tr>
              )}
              {activeLeases.map((l) => {
                const rent = Number(l.monthlyRent);
                const st = statusOf(l.id, rent);
                const ar = arByLease.get(l.id);
                return (
                  <tr key={l.id}>
                    <td className="td">
                      <Link href={`/tenants/${l.id}`} className="text-primary font-medium">
                        {l.tenant.name}
                      </Link>
                      {!l.stampedDate && <span className="badge bg-amber-100 text-amber-700 ml-2">Not stamped</span>}
                    </td>
                    <td className="td">{l.property.name}</td>
                    <td className="td text-right">
                      <Money value={rent} symbol={sym} colorNegative={false} />
                    </td>
                    <td className="td text-right">
                      <Money value={ar ? ar.total.toString() : 0} symbol={sym} colorNegative={false} />
                    </td>
                    <td className="td">
                      <span className={`badge ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="td no-print">
                      <div className="flex gap-1 items-center">
                        <form action={recordRentPaymentAction} className="flex gap-1 items-center">
                          <input type="hidden" name="leaseId" value={l.id} />
                          <input type="hidden" name="sourceType" value={ar && Number(ar.total) > 0 ? "RENT_PAYMENT" : "RENT_RECEIVED"} />
                          <input type="hidden" name="description" value={`Rent — ${l.tenant.name}`} />
                          <input className="input num w-24 py-1" type="number" step="0.01" name="amount" defaultValue={rent.toFixed(2)} />
                          <button className="btn-primary py-1">Pay</button>
                        </form>
                        <Link href={`/tenants/${l.id}/statement`} className="btn-ghost py-1">
                          Statement
                        </Link>
                        <a href={`/api/leases/${l.id}/agreement`} className="btn-ghost py-1">
                          Agreement
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Lease list + filters */}
      <div className="card">
        <div className="p-4 border-b border-line flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-semibold">All leases</h2>
          <div className="flex gap-1 text-sm no-print">
            {[
              ["", "All"],
              ["expiring", "Expiring soon"],
              ["expired", "Expired"],
              ["mtm", "Month-to-month"],
            ].map(([v, lab]) => (
              <Link key={v} href={`/tenants${v ? `?status=${v}` : ""}`} className={`px-2 py-1 rounded ${sp.status === v || (!sp.status && !v) ? "bg-primary text-white" : "border border-line"}`}>
                {lab}
              </Link>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr>
                <th className="th">Tenant</th>
                <th className="th">Property</th>
                <th className="th text-right">Rent</th>
                <th className="th">Due day</th>
                <th className="th text-right">Deposit</th>
                <th className="th">Term</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id}>
                  <td className="td">
                    <Link href={`/tenants/${l.id}`} className="text-primary">
                      {l.tenant.name}
                    </Link>
                    <a href={`/api/leases/${l.id}/agreement`} className="block text-xs text-muted hover:text-primary no-print">
                      Download agreement
                    </a>
                  </td>
                  <td className="td">{l.property.name}</td>
                  <td className="td text-right num">{Number(l.monthlyRent).toFixed(2)}</td>
                  <td className="td">{l.dueDay}</td>
                  <td className="td text-right num">{Number(l.depositAmount).toFixed(2)}</td>
                  <td className="td whitespace-nowrap text-xs">
                    {l.startDate.toISOString().slice(0, 10)} → {l.endDate ? l.endDate.toISOString().slice(0, 10) : "open"}
                  </td>
                  <td className="td">
                    <span className={`badge ${l.status === "ACTIVE" ? "bg-income/10 text-income" : "bg-line text-muted"}`}>{l.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add tenant + add lease */}
      <div className="grid lg:grid-cols-2 gap-4 no-print">
        <details className="card p-4">
          <summary className="cursor-pointer font-medium text-primary">+ Add tenant</summary>
          <form action={createTenantAction} className="mt-4 space-y-3">
            <div>
              <label className="label">Name</label>
              <input className="input" name="name" required />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Phone</label>
                <input className="input" name="phone" />
              </div>
              <div>
                <label className="label">Email</label>
                <input className="input" name="email" type="email" />
              </div>
            </div>
            <div>
              <label className="label">IC number (if personal)</label>
              <input className="input" name="idNumber" placeholder="e.g. 900101-10-1234" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Company old reg. no.</label>
                <input className="input" name="regNoOld" placeholder="e.g. 773261-M" />
              </div>
              <div>
                <label className="label">Company new reg. no.</label>
                <input className="input" name="regNoNew" placeholder="e.g. 202501031985" />
              </div>
            </div>
            <div>
              <label className="label">Address</label>
              <input className="input" name="address" />
            </div>
            <button className="btn-primary">Add tenant</button>
          </form>
        </details>

        <details className="card p-4">
          <summary className="cursor-pointer font-medium text-primary">+ Add lease</summary>
          <form action={createLeaseAction} className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Property</label>
                <select className="input" name="propertyId" required>
                  {properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">Tenant</label>
                <select className="input" name="tenantId" required>
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Start date</label>
                <input className="input" type="date" name="startDate" required />
              </div>
              <div>
                <label className="label">End date (optional)</label>
                <input className="input" type="date" name="endDate" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Monthly rent</label>
                <input className="input num" type="number" step="0.01" name="monthlyRent" required />
              </div>
              <div>
                <label className="label">Due day</label>
                <input className="input num" type="number" min="1" max="28" name="dueDay" defaultValue="1" />
              </div>
              <div>
                <label className="label">Deposit</label>
                <input className="input num" type="number" step="0.01" name="depositAmount" defaultValue="0" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Signed date</label>
                <input className="input" type="date" name="signedDate" />
              </div>
              <div>
                <label className="label">Stamped date</label>
                <input className="input" type="date" name="stampedDate" />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="autoInvoice" defaultChecked /> Auto-invoice rent monthly
            </label>
            <button className="btn-primary">Add lease</button>
          </form>
        </details>
      </div>
    </div>
  );
}
