import Link from "next/link";
import NetChart from "@/components/NetChart";
import { Money } from "@/components/Money";
import { getActiveCompany } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { balanceSheet, profitAndLoss } from "@/lib/reports";
import { getAgingReport } from "@/lib/services/arrears";
import { getLedgerLines } from "@/lib/services/ledger";
import { getBillsDue } from "@/lib/services/payables";

export const dynamic = "force-dynamic";

function monthRange(d: Date) {
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59));
  return { from, to };
}

export default async function Overview() {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const now = new Date();
  const lines = await getLedgerLines(company.id);

  const { from, to } = monthRange(now);
  const pl = profitAndLoss(lines, from, to);
  const bs = balanceSheet(lines, now);
  const cash = bs.assets.filter((a) => a.code === "1000" || a.code === "1010").reduce((s, a) => s + Number(a.amount), 0);

  // 12-month net chart
  const chart: { month: string; net: number }[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const r = monthRange(d);
    chart.push({
      month: d.toLocaleDateString("en", { month: "short", timeZone: "UTC" }),
      net: Number(profitAndLoss(lines, r.from, r.to).net),
    });
  }

  // Per-property net (all time)
  const properties = await prisma.property.findMany({ where: { companyId: company.id }, orderBy: { name: "asc" } });
  const propNet = properties.map((p) => ({
    name: p.name,
    net: Number(profitAndLoss(lines, undefined, undefined, p.id).net),
  }));

  // Attention items
  const aging = await getAgingReport(company.id, now);
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const leases = await prisma.lease.findMany({
    where: { companyId: company.id, status: "ACTIVE" },
    include: { tenant: true, property: true, documents: true },
  });
  const expiring = leases.filter((l) => l.endDate && l.endDate <= in90);
  const unstamped = leases.filter((l) => !l.stampedDate);
  const noAgreement = leases.filter((l) => l.documents.length === 0);
  const overdue = aging.rows.filter((r) => Number(r.b31_60) + Number(r.b61_90) + Number(r.b90plus) > 0);
  const billsDue = await getBillsDue(company.id, now, 14);
  const attentionCount = overdue.length + expiring.length + unstamped.length + noAgreement.length + billsDue.length;

  const cardCls = "card p-4";
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Overview</h1>
          <p className="text-sm text-muted">{company.name}</p>
        </div>
        <Link href="/ledger" className="btn-primary no-print">
          + New entry
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={cardCls}>
          <div className="text-xs text-muted uppercase tracking-wide">Income this month</div>
          <div className="text-xl font-bold text-income mt-1">
            <Money value={pl.totalIncome.toString()} symbol={sym} colorNegative={false} />
          </div>
        </div>
        <div className={cardCls}>
          <div className="text-xs text-muted uppercase tracking-wide">Expenses this month</div>
          <div className="text-xl font-bold text-expense mt-1">
            <Money value={pl.totalExpense.toString()} symbol={sym} colorNegative={false} />
          </div>
        </div>
        <div className={cardCls}>
          <div className="text-xs text-muted uppercase tracking-wide">Net this month</div>
          <div className="text-xl font-bold mt-1">
            <Money value={pl.net.toString()} symbol={sym} />
          </div>
        </div>
        <div className={cardCls}>
          <div className="text-xs text-muted uppercase tracking-wide">Cash balance</div>
          <div className="text-xl font-bold mt-1">
            <Money value={cash} symbol={sym} />
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 card p-4">
          <h2 className="font-semibold mb-3">Net income — last 12 months</h2>
          <NetChart data={chart} />
        </div>

        <div className="card p-4">
          <h2 className="font-semibold mb-3">
            Attention {attentionCount > 0 && <span className="badge bg-expense/10 text-expense ml-1">{attentionCount}</span>}
          </h2>
          {attentionCount === 0 ? (
            <p className="text-sm text-muted">All clear — nothing needs attention.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {overdue.map((r) => (
                <li key={"od" + r.leaseId} className="flex justify-between">
                  <span>⚠️ Overdue rent — {r.tenantName}</span>
                  <Money value={r.total.toString()} symbol={sym} className="text-expense" />
                </li>
              ))}
              {billsDue.map((b) => (
                <li key={"bill" + b.id} className="flex justify-between">
                  <span>
                    {b.overdue ? "🔴" : "🧾"} Bill {b.overdue ? "overdue" : "due"} — {b.supplierName} ({b.dueDate.toISOString().slice(0, 10)})
                  </span>
                  <Money value={b.balance} symbol={sym} className={b.overdue ? "text-expense" : ""} colorNegative={false} />
                </li>
              ))}
              {expiring.map((l) => (
                <li key={"ex" + l.id}>
                  📅 Lease expiring — {l.tenant.name} ({l.endDate?.toISOString().slice(0, 10)})
                </li>
              ))}
              {unstamped.map((l) => (
                <li key={"us" + l.id}>🏷️ Not stamped — {l.tenant.name} @ {l.property.name}</li>
              ))}
              {noAgreement.map((l) => (
                <li key={"na" + l.id}>📎 No agreement uploaded — {l.tenant.name}</li>
              ))}
            </ul>
          )}
          <Link href="/tenants" className="text-primary text-sm font-medium mt-3 inline-block no-print">
            Manage leases →
          </Link>
        </div>
      </div>

      <div className="card p-4">
        <h2 className="font-semibold mb-3">Net by property (all time)</h2>
        {propNet.length === 0 ? (
          <p className="text-sm text-muted">
            No properties yet.{" "}
            <Link href="/properties" className="text-primary">
              Add one →
            </Link>
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Property</th>
                <th className="th text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {propNet.map((p) => (
                <tr key={p.name}>
                  <td className="td">{p.name}</td>
                  <td className="td text-right">
                    <Money value={p.net} symbol={sym} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
