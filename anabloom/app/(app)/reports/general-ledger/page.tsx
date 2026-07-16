import Link from "next/link";
import ReportToolbar from "@/components/ReportToolbar";
import { getActiveCompany } from "@/lib/company";
import { formatMoney } from "@/lib/money";
import { generalLedger } from "@/lib/reports";
import { prisma } from "@/lib/prisma";
import { getGeneralLedgerData } from "@/lib/services/ledgerReports";

export const dynamic = "force-dynamic";

export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; from?: string; to?: string; property?: string }>;
}) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const sp = await searchParams;
  const now = new Date();
  const from = new Date((sp.from || `${now.getUTCFullYear()}-01-01`) + "T00:00:00Z");
  const to = new Date((sp.to || now.toISOString().slice(0, 10)) + "T23:59:59Z");
  const accountCode = sp.account && sp.account !== "all" ? sp.account : undefined;
  const propertyId = sp.property || undefined;

  const [lines, accounts, properties] = await Promise.all([
    getGeneralLedgerData(company.id),
    prisma.account.findMany({ where: { companyId: company.id }, orderBy: { code: "asc" } }),
    prisma.property.findMany({ where: { companyId: company.id }, orderBy: { name: "asc" } }),
  ]);
  const gl = generalLedger(lines, { from, to, accountCode, propertyId });

  const csv: string[][] = [["Account", "Date", "Description", "Property", "Debit", "Credit", "Balance"]];
  for (const a of gl) {
    csv.push([`${a.code} ${a.name}`, "", "Opening balance", "", "", "", a.opening.toFixed(2)]);
    for (const r of a.rows) csv.push(["", r.date, r.description, r.propertyName, r.debit.toFixed(2), r.credit.toFixed(2), r.balance.toFixed(2)]);
    csv.push(["", "", "Closing balance", "", a.totalDebit.toFixed(2), a.totalCredit.toFixed(2), a.closing.toFixed(2)]);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/reports" className="text-sm text-primary no-print">
            ← Reports
          </Link>
          <h1 className="text-2xl font-bold">General Ledger</h1>
          <p className="text-sm text-muted">{company.name}</p>
        </div>
        <ReportToolbar rows={csv} filename="general-ledger.csv" />
      </div>

      <form method="get" className="card p-3 flex flex-wrap gap-3 items-end no-print">
        <div>
          <label className="label">Account</label>
          <select name="account" defaultValue={sp.account || "all"} className="input">
            <option value="all">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.code}>
                {a.code} {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">From</label>
          <input className="input" type="date" name="from" defaultValue={from.toISOString().slice(0, 10)} />
        </div>
        <div>
          <label className="label">To</label>
          <input className="input" type="date" name="to" defaultValue={to.toISOString().slice(0, 10)} />
        </div>
        <div>
          <label className="label">Property</label>
          <select name="property" defaultValue={propertyId || ""} className="input">
            <option value="">All</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <button className="btn-primary">Update</button>
      </form>

      {gl.length === 0 ? (
        <p className="card p-6 text-center text-muted">No activity for the selection.</p>
      ) : (
        gl.map((a) => (
          <div key={a.code} className="card overflow-x-auto">
            <div className="px-3 py-2 border-b border-line font-semibold bg-canvas">
              {a.code} — {a.name}
            </div>
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className="th">Date</th>
                  <th className="th">Description</th>
                  <th className="th">Property</th>
                  <th className="th text-right">Debit</th>
                  <th className="th text-right">Credit</th>
                  <th className="th text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                <tr className="text-muted">
                  <td className="td" colSpan={5}>
                    Opening balance
                  </td>
                  <td className="td text-right num">{formatMoney(a.opening, sym)}</td>
                </tr>
                {a.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="td whitespace-nowrap">{r.date}</td>
                    <td className="td">{r.description}</td>
                    <td className="td">{r.propertyName || "—"}</td>
                    <td className="td text-right num">{r.debit.isZero() ? "" : formatMoney(r.debit, sym)}</td>
                    <td className="td text-right num">{r.credit.isZero() ? "" : formatMoney(r.credit, sym)}</td>
                    <td className="td text-right num">{formatMoney(r.balance, sym)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold border-t-2 border-ink">
                  <td className="td" colSpan={3}>
                    Closing balance
                  </td>
                  <td className="td text-right num">{formatMoney(a.totalDebit, sym)}</td>
                  <td className="td text-right num">{formatMoney(a.totalCredit, sym)}</td>
                  <td className="td text-right num">{formatMoney(a.closing, sym)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ))
      )}
    </div>
  );
}
