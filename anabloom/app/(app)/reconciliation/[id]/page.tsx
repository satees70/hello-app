import Link from "next/link";
import { notFound } from "next/navigation";
import { Money } from "@/components/Money";
import {
  autoMatchAction,
  confirmMatchAction,
  createEntryForLineAction,
  deleteStatementAction,
  finishReconciliationAction,
  ignoreLineAction,
  reopenReconciliationAction,
} from "@/app/reconcile-actions";
import { formatMoney } from "@/lib/money";
import { canFinishReconciliation, continuityCheck } from "@/lib/reconcile/matching";
import { prisma } from "@/lib/prisma";
import { getUser } from "@/lib/session";
import { getCashLines } from "@/lib/services/ledger";

export const dynamic = "force-dynamic";

const MATCH_CLS: Record<string, string> = {
  UNMATCHED: "bg-line text-muted",
  AUTO_MATCHED: "bg-amber-100 text-amber-700",
  CONFIRMED: "bg-income/10 text-income",
  ENTRY_CREATED: "bg-income/10 text-income",
  IGNORED: "bg-line text-muted",
};

export default async function ReconcileWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  const sym = user.currency;
  const { id } = await params;
  const statement = await prisma.bankStatement.findFirst({
    where: { id, userId: user.id },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });
  if (!statement) notFound();

  const [cash, properties, accounts] = await Promise.all([
    getCashLines(user.id, true),
    prisma.property.findMany({ where: { userId: user.id }, orderBy: { name: "asc" } }),
    prisma.account.findMany({ where: { userId: user.id, active: true }, orderBy: { code: "asc" } }),
  ]);
  const cashById = new Map(cash.map((c) => [c.id, c]));
  const incomeAccounts = accounts.filter((a) => a.type === "INCOME");
  const expenseAccounts = accounts.filter((a) => a.type === "EXPENSE");

  const continuity = continuityCheck(
    statement.openingBalance.toString(),
    statement.lines.map((l) => ({ amount: l.amount.toString() })),
    statement.closingBalance.toString()
  );
  const finish = canFinishReconciliation(
    statement.openingBalance.toString(),
    statement.closingBalance.toString(),
    statement.lines.map((l) => ({ amount: l.amount.toString(), matchStatus: l.matchStatus as never }))
  );

  const reconciled = statement.status === "RECONCILED";
  const report = statement.reportJson ? (JSON.parse(statement.reportJson) as { clearedIn: string; clearedOut: string; outstanding: { date: string; description: string; amount: string }[]; difference: string }) : null;

  const matchedIds = new Set(statement.lines.map((l) => l.matchedJournalLineId).filter(Boolean));
  const outstanding = cash.filter((c) => !matchedIds.has(c.id) && c.date >= statement.periodStart && c.date <= statement.periodEnd);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <Link href="/reconciliation" className="text-sm text-primary no-print">
            ← Statements
          </Link>
          <h1 className="text-2xl font-bold">{statement.fileName}</h1>
          <p className="text-sm text-muted">
            {statement.bankName || "Bank"} · {statement.periodStart.toISOString().slice(0, 10)} → {statement.periodEnd.toISOString().slice(0, 10)}
          </p>
        </div>
        <div className="flex gap-2 no-print">
          {statement.status === "DRAFT" && (
            <form action={autoMatchAction}>
              <input type="hidden" name="statementId" value={statement.id} />
              <button className="btn-primary">Run auto-match</button>
            </form>
          )}
          <form action={deleteStatementAction}>
            <input type="hidden" name="statementId" value={statement.id} />
            <button className="btn-ghost text-expense">Delete</button>
          </form>
        </div>
      </div>

      {/* Balances + continuity */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Opening" value={formatMoney(statement.openingBalance, sym)} />
        <Stat label="Closing" value={formatMoney(statement.closingBalance, sym)} />
        <Stat label="Sum of lines" value={formatMoney(statement.lines.reduce((s, l) => s + Number(l.amount), 0), sym)} />
        <Stat label="Continuity diff" value={formatMoney(continuity.difference, sym)} highlight={!continuity.ok} />
      </div>

      {/* Workspace */}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[860px]">
          <thead>
            <tr>
              <th className="th">Date</th>
              <th className="th">Description</th>
              <th className="th text-right">Amount</th>
              <th className="th">Match</th>
              <th className="th no-print">Actions</th>
            </tr>
          </thead>
          <tbody>
            {statement.lines.map((l) => {
              const amt = Number(l.amount);
              const isIn = amt > 0;
              const suggested = l.matchedJournalLineId ? cashById.get(l.matchedJournalLineId) : null;
              return (
                <tr key={l.id} className="align-top">
                  <td className="td whitespace-nowrap">{l.date.toISOString().slice(0, 10)}</td>
                  <td className="td">{l.description}</td>
                  <td className={`td text-right num ${isIn ? "text-income" : "text-expense"}`}>{formatMoney(amt, sym)}</td>
                  <td className="td">
                    <span className={`badge ${MATCH_CLS[l.matchStatus]}`}>{l.matchStatus.replace("_", " ")}</span>
                    {l.matchConfidence != null && <div className="text-xs text-muted mt-1">conf {(l.matchConfidence * 100).toFixed(0)}%</div>}
                    {suggested && <div className="text-xs text-muted mt-1">↔ {suggested.description} ({formatMoney(suggested.amount, sym)})</div>}
                  </td>
                  <td className="td no-print">
                    {reconciled || l.matchStatus === "IGNORED" ? (
                      <span className="text-xs text-muted">—</span>
                    ) : (
                      <div className="space-y-1">
                        {/* Confirm a match (pre-selects the suggestion) */}
                        <form action={confirmMatchAction} className="flex gap-1 items-center">
                          <input type="hidden" name="statementId" value={statement.id} />
                          <input type="hidden" name="statementLineId" value={l.id} />
                          <select name="journalLineId" className="input py-1 text-xs max-w-[220px]" defaultValue={l.matchedJournalLineId ?? ""}>
                            <option value="">— pick book entry —</option>
                            {cash
                              .filter((c) => Math.abs(Number(c.amount) - amt) < 0.005)
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.date.toISOString().slice(0, 10)} {c.description} ({Number(c.amount).toFixed(2)})
                                </option>
                              ))}
                          </select>
                          <button className="text-primary text-xs" disabled={l.matchStatus === "CONFIRMED"}>
                            Confirm
                          </button>
                        </form>
                        {/* Create entry + Ignore */}
                        <div className="flex gap-2">
                          <details>
                            <summary className="cursor-pointer text-xs text-primary">Create entry</summary>
                            <form action={createEntryForLineAction} className="mt-1 flex flex-wrap gap-1 items-end bg-canvas p-2 rounded">
                              <input type="hidden" name="statementId" value={statement.id} />
                              <input type="hidden" name="statementLineId" value={l.id} />
                              <select name="sourceType" className="input py-1 text-xs" defaultValue={isIn ? "RENT_RECEIVED" : "EXPENSE_PAID"}>
                                {isIn ? (
                                  <>
                                    <option value="RENT_RECEIVED">Rent received</option>
                                    <option value="OTHER_INCOME_RECEIVED">Other income</option>
                                  </>
                                ) : (
                                  <>
                                    <option value="EXPENSE_PAID">Expense paid</option>
                                  </>
                                )}
                              </select>
                              <select name="propertyId" className="input py-1 text-xs">
                                <option value="">Company</option>
                                {properties.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </select>
                              <select name="accountCode" className="input py-1 text-xs">
                                {(isIn ? incomeAccounts : expenseAccounts).map((a) => (
                                  <option key={a.code} value={a.code}>
                                    {a.code} {a.name}
                                  </option>
                                ))}
                              </select>
                              <button className="btn-primary py-1 text-xs">Create</button>
                            </form>
                          </details>
                          <form action={ignoreLineAction}>
                            <input type="hidden" name="statementId" value={statement.id} />
                            <input type="hidden" name="statementLineId" value={l.id} />
                            <button className="text-xs text-muted hover:text-expense">Ignore</button>
                          </form>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Outstanding book items */}
      <div className="card p-4">
        <h2 className="font-semibold mb-2">Outstanding / uncleared book items (this period)</h2>
        {outstanding.length === 0 ? (
          <p className="text-sm text-muted">None — every book cash movement in the period is on the statement.</p>
        ) : (
          <ul className="text-sm divide-y divide-line">
            {outstanding.map((o) => (
              <li key={o.id} className="py-1 flex justify-between">
                <span>
                  {o.date.toISOString().slice(0, 10)} — {o.description}
                </span>
                <Money value={o.amount.toString()} symbol={sym} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Finish / report */}
      {reconciled && report ? (
        <div className="card p-4 space-y-2">
          <h2 className="font-semibold text-income">Reconciled ✓</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="Cleared in" value={formatMoney(report.clearedIn, sym)} />
            <Stat label="Cleared out" value={formatMoney(report.clearedOut, sym)} />
            <Stat label="Outstanding items" value={String(report.outstanding.length)} />
            <Stat label="Difference" value={formatMoney(report.difference, sym)} />
          </div>
          <div className="flex gap-2 no-print pt-2">
            <form action={reopenReconciliationAction}>
              <input type="hidden" name="statementId" value={statement.id} />
              <button className="btn-ghost">Reopen</button>
            </form>
          </div>
        </div>
      ) : (
        <div className="card p-4 flex items-center justify-between flex-wrap gap-3 no-print">
          <div className="text-sm">
            {finish.canFinish ? (
              <span className="text-income font-medium">Ready to finish — everything resolved and balanced.</span>
            ) : (
              <span className="text-muted">
                {!finish.allResolved && "Resolve every line (confirm / create / ignore). "}
                {!finish.continuity.ok && `Continuity difference ${formatMoney(finish.continuity.difference, sym)}.`}
              </span>
            )}
          </div>
          <form action={finishReconciliationAction}>
            <input type="hidden" name="statementId" value={statement.id} />
            <button className="btn-primary" disabled={!finish.canFinish}>
              Finish reconciliation
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="card p-3">
      <div className="text-xs text-muted uppercase tracking-wide">{label}</div>
      <div className={`num font-semibold mt-1 ${highlight ? "text-expense" : ""}`}>{value}</div>
    </div>
  );
}
