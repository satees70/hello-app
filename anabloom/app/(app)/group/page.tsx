import Link from "next/link";
import GroupNetChart from "@/components/GroupNetChart";
import { Money } from "@/components/Money";
import { getUser } from "@/lib/session";
import { profitAndLoss } from "@/lib/reports";
import { getGroupAttention, getGroupMetrics } from "@/lib/services/group";

export const dynamic = "force-dynamic";

function monthRange(d: Date) {
  return {
    from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
    to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59)),
  };
}

const KIND_ICON: Record<string, string> = { overdue: "⚠️", expiring: "📅", unstamped: "🏷️", no_agreement: "📎", bill_due: "🧾" };

export default async function GroupOverview() {
  const user = await getUser();
  const now = new Date();
  const { ledgers, metrics } = await getGroupMetrics(user.id, now);
  const attention = await getGroupAttention(user.id, now);
  const sym = metrics[0]?.currency || "RM";

  const groupNet = metrics.reduce((s, m) => s + m.netThisMonth, 0);
  const groupCash = metrics.reduce((s, m) => s + m.cash, 0);
  const groupOverdue = metrics.reduce((s, m) => s + m.overdue, 0);

  // Combined 12-month chart: one series per company.
  const chart: Record<string, number | string>[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const r = monthRange(d);
    const row: Record<string, number | string> = { month: d.toLocaleDateString("en", { month: "short", timeZone: "UTC" }) };
    for (const c of ledgers) row[c.companyName] = Number(profitAndLoss(c.lines, r.from, r.to).net);
    chart.push(row);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg bg-primary text-white p-5">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold">Group overview</h1>
            <p className="text-white/80 text-sm">All companies combined — management summary</p>
          </div>
          <div className="flex gap-2 no-print">
            <Link href="/group/pl" className="btn bg-white/15 text-white hover:bg-white/25">
              Group P&amp;L
            </Link>
            <Link href="/group/balance-sheet" className="btn bg-white/15 text-white hover:bg-white/25">
              Group Balance Sheet
            </Link>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 mt-4">
          <GroupStat label="Net this month" value={<Money value={groupNet} symbol={sym} />} />
          <GroupStat label="Cash now" value={<Money value={groupCash} symbol={sym} colorNegative={false} />} />
          <GroupStat label="Overdue rent" value={<Money value={groupOverdue} symbol={sym} colorNegative={false} />} />
        </div>
      </div>

      {/* Per-company cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {metrics.map((m) => (
          <div key={m.companyId} className="card p-4 space-y-2">
            <h3 className="font-semibold">{m.companyName}</h3>
            <Row label="Net this month" value={<Money value={m.netThisMonth} symbol={m.currency} />} />
            <Row label="Cash now" value={<Money value={m.cash} symbol={m.currency} colorNegative={false} />} />
            <Row label="Overdue rent" value={<Money value={m.overdue} symbol={m.currency} colorNegative={false} />} />
          </div>
        ))}
      </div>

      <div className="card p-4">
        <h2 className="font-semibold mb-3">Net income — last 12 months (per company)</h2>
        <GroupNetChart data={chart} companies={ledgers.map((c) => c.companyName)} />
      </div>

      <div className="card p-4">
        <h2 className="font-semibold mb-3">
          Attention {attention.length > 0 && <span className="badge bg-expense/10 text-expense ml-1">{attention.length}</span>}
        </h2>
        {attention.length === 0 ? (
          <p className="text-sm text-muted">All clear across every company.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {attention.map((a, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span>
                  {KIND_ICON[a.kind]} <span className="badge bg-primary/10 text-primary mr-1">{a.companyName}</span>
                  {a.label}
                </span>
                {a.amount != null && <Money value={a.amount} symbol={sym} className="text-expense" />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function GroupStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-white/10 p-3">
      <div className="text-xs text-white/70 uppercase tracking-wide">{label}</div>
      <div className="text-lg font-bold mt-1">{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted">{label}</span>
      {value}
    </div>
  );
}
