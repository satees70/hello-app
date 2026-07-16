import { balanceSheet, CompanyLedger, LedgerLine, profitAndLoss } from "../reports";
import { prisma } from "../prisma";
import { getLedgerLines } from "./ledger";
import { getAgingReport } from "./arrears";
import { getBillsDue } from "./payables";

export interface CompanyLedgerWithMeta extends CompanyLedger {
  currency: string;
}

/** All of a user's companies with their full ledgers (for group reports). */
export async function getCompanyLedgers(userId: string): Promise<CompanyLedgerWithMeta[]> {
  const companies = await prisma.company.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const out: CompanyLedgerWithMeta[] = [];
  for (const c of companies) {
    out.push({ companyId: c.id, companyName: c.name, currency: c.currency, lines: await getLedgerLines(c.id) });
  }
  return out;
}

export interface CompanyMetrics {
  companyId: string;
  companyName: string;
  currency: string;
  netThisMonth: number;
  cash: number;
  overdue: number;
}

function monthRange(d: Date) {
  return {
    from: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
    to: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59)),
  };
}

export async function getGroupMetrics(userId: string, now = new Date()): Promise<{
  ledgers: CompanyLedgerWithMeta[];
  metrics: CompanyMetrics[];
}> {
  const ledgers = await getCompanyLedgers(userId);
  const { from, to } = monthRange(now);
  const metrics: CompanyMetrics[] = [];
  for (const c of ledgers) {
    const pl = profitAndLoss(c.lines, from, to);
    const bs = balanceSheet(c.lines, now);
    const cash = bs.assets.filter((a) => a.code === "1000" || a.code === "1010").reduce((s, a) => s + Number(a.amount), 0);
    const aging = await getAgingReport(c.companyId, now);
    const overdue = aging.rows.reduce((s, r) => s + Number(r.b31_60) + Number(r.b61_90) + Number(r.b90plus), 0);
    metrics.push({
      companyId: c.companyId,
      companyName: c.companyName,
      currency: c.currency,
      netThisMonth: Number(pl.net),
      cash,
      overdue,
    });
  }
  return { ledgers, metrics };
}

export interface AttentionItem {
  companyId: string;
  companyName: string;
  kind: "overdue" | "expiring" | "unstamped" | "no_agreement" | "bill_due";
  label: string;
  amount?: number;
}

/** Combined attention list across all companies, tagged by company. */
export async function getGroupAttention(userId: string, now = new Date()): Promise<AttentionItem[]> {
  const companies = await prisma.company.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const items: AttentionItem[] = [];
  for (const c of companies) {
    const aging = await getAgingReport(c.id, now);
    for (const r of aging.rows) {
      const overdue = Number(r.b31_60) + Number(r.b61_90) + Number(r.b90plus);
      if (overdue > 0) items.push({ companyId: c.id, companyName: c.name, kind: "overdue", label: `Overdue rent — ${r.tenantName}`, amount: Number(r.total) });
    }
    const leases = await prisma.lease.findMany({
      where: { companyId: c.id, status: "ACTIVE" },
      include: { tenant: true, property: true, documents: true },
    });
    for (const l of leases) {
      if (l.endDate && l.endDate <= in90 && l.endDate >= now)
        items.push({ companyId: c.id, companyName: c.name, kind: "expiring", label: `Lease expiring — ${l.tenant.name} (${l.endDate.toISOString().slice(0, 10)})` });
      if (!l.stampedDate) items.push({ companyId: c.id, companyName: c.name, kind: "unstamped", label: `Not stamped — ${l.tenant.name} @ ${l.property.name}` });
      if (l.documents.length === 0) items.push({ companyId: c.id, companyName: c.name, kind: "no_agreement", label: `No agreement uploaded — ${l.tenant.name}` });
    }
    const billsDue = await getBillsDue(c.id, now, 14);
    for (const b of billsDue)
      items.push({ companyId: c.id, companyName: c.name, kind: "bill_due", label: `Bill ${b.overdue ? "overdue" : "due"} — ${b.supplierName}`, amount: b.balance });
  }
  return items;
}
