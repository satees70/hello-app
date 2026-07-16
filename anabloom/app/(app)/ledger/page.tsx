import Link from "next/link";
import { Prisma } from "@prisma/client";
import ConfirmButton from "@/components/ConfirmButton";
import { Money } from "@/components/Money";
import NewEntryForm from "@/components/NewEntryForm";
import { deleteEntryAction } from "@/app/actions";
import { SOURCE_TYPE_LABELS, SourceType } from "@/lib/enums";
import { prisma } from "@/lib/prisma";
import { getActiveCompany } from "@/lib/company";

export const dynamic = "force-dynamic";

export default async function LedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ property?: string; month?: string; type?: string }>;
}) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const sp = await searchParams;

  const where: Prisma.JournalEntryWhereInput = { companyId: company.id };
  if (sp.property) where.propertyId = sp.property;
  if (sp.type) where.sourceType = sp.type;
  if (sp.month) {
    const [y, m] = sp.month.split("-").map(Number);
    where.date = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
  }

  const [entries, properties, accounts] = await Promise.all([
    prisma.journalEntry.findMany({
      where,
      include: { lines: { include: { account: true } }, property: true, attachments: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: 500,
    }),
    prisma.property.findMany({ where: { companyId: company.id }, orderBy: { name: "asc" } }),
    prisma.account.findMany({ where: { companyId: company.id }, orderBy: { code: "asc" } }),
  ]);
  const leases = await prisma.lease.findMany({
    where: { companyId: company.id, status: "ACTIVE" },
    include: { tenant: true, property: true },
  });
  const suppliers = await prisma.supplier.findMany({ where: { companyId: company.id }, orderBy: { name: "asc" } });

  const incomeAccounts = accounts.filter((a) => a.type === "INCOME").map((a) => ({ code: a.code, name: a.name }));
  const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE").map((a) => ({ code: a.code, name: a.name }));

  const qs = new URLSearchParams(sp as Record<string, string>).toString();

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Ledger</h1>
        <div className="flex gap-2 no-print">
          <Link href="/ledger/manual" className="btn-ghost">
            Advanced: manual journal
          </Link>
          <a href={`/api/export/ledger?${qs}`} className="btn-ghost">
            Export CSV
          </a>
        </div>
      </div>

      <NewEntryForm
        properties={properties.map((p) => ({ id: p.id, label: p.name }))}
        leases={leases.map((l) => ({ id: l.id, label: `${l.tenant.name} — ${l.property.name}` }))}
        incomeAccounts={incomeAccounts}
        expenseAccounts={expenseAccounts}
        suppliers={suppliers.map((sp) => ({ id: sp.id, label: sp.name }))}
      />

      {/* Filters */}
      <form className="card p-3 flex flex-wrap gap-3 items-end no-print" method="get">
        <div>
          <label className="label">Property</label>
          <select name="property" defaultValue={sp.property || ""} className="input">
            <option value="">All</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Month</label>
          <input type="month" name="month" defaultValue={sp.month || ""} className="input" />
        </div>
        <div>
          <label className="label">Type</label>
          <select name="type" defaultValue={sp.type || ""} className="input">
            <option value="">All</option>
            {Object.entries(SOURCE_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-primary">Filter</button>
        <Link href="/ledger" className="btn-ghost">
          Reset
        </Link>
      </form>

      <div className="card overflow-x-auto">
        {entries.length === 0 ? (
          <p className="p-6 text-center text-muted">No entries yet. Use “New entry” above to record your first transaction.</p>
        ) : (
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                <th className="th">Date</th>
                <th className="th">Property</th>
                <th className="th">Description</th>
                <th className="th">Type</th>
                <th className="th text-right">Amount</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const amount = e.lines.reduce((s, l) => s + Number(l.debit), 0);
                return (
                  <tr key={e.id} className="align-top">
                    <td className="td whitespace-nowrap">{e.date.toISOString().slice(0, 10)}</td>
                    <td className="td">{e.property?.name || "—"}</td>
                    <td className="td">
                      <details>
                        <summary className="cursor-pointer">
                          {e.description}
                          {e.attachments.length > 0 && <span title="Has attachments"> 📎</span>}
                        </summary>
                        <div className="mt-2 text-xs text-muted">
                          {e.lines.map((l) => (
                            <div key={l.id} className="flex justify-between gap-4 max-w-xs">
                              <span>
                                {l.account.code} {l.account.name}
                              </span>
                              <span className="num">
                                {Number(l.debit) > 0 ? `Dr ${Number(l.debit).toFixed(2)}` : `Cr ${Number(l.credit).toFixed(2)}`}
                              </span>
                            </div>
                          ))}
                        </div>
                      </details>
                    </td>
                    <td className="td">
                      <span className="badge bg-primary/10 text-primary">
                        {SOURCE_TYPE_LABELS[e.sourceType as SourceType] || e.sourceType}
                      </span>
                    </td>
                    <td className="td text-right">
                      <Money value={amount} symbol={sym} colorNegative={false} />
                    </td>
                    <td className="td text-right no-print whitespace-nowrap">
                      <Link href={`/ledger/${e.id}`} className="text-primary text-xs hover:underline mr-3">
                        View
                      </Link>
                      <ConfirmButton action={deleteEntryAction} id={e.id} message="Delete this entry and its lines?" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
