import Link from "next/link";

const REPORTS = [
  { href: "/reports/trial-balance", title: "Trial Balance", desc: "Every account's balance as of a date; must balance." },
  { href: "/reports/general-ledger", title: "General Ledger", desc: "Per-account detail: opening, every posting, running balance, closing." },
  { href: "/reports/profit-loss", title: "Profit & Loss", desc: "Income less expenses over a date range, per property or consolidated." },
  { href: "/reports/balance-sheet", title: "Balance Sheet", desc: "Assets = Liabilities + Equity as of a date." },
  { href: "/reports/aging", title: "AR Aging", desc: "Outstanding rent per tenant, bucketed by age." },
];

export default function ReportsIndex() {
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Reports</h1>
      <div className="grid sm:grid-cols-2 gap-4">
        {REPORTS.map((r) => (
          <Link key={r.href} href={r.href} className="card p-5 hover:border-primary transition-colors">
            <h2 className="font-semibold text-primary">{r.title}</h2>
            <p className="text-sm text-muted mt-1">{r.desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
