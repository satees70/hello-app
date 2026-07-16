"use client";

import { useMemo, useState } from "react";
import { createEntryAction } from "@/app/actions";

interface AccountOpt {
  code: string;
  name: string;
}
interface Line {
  code: string;
  debit: string;
  credit: string;
}

export default function ManualEntryForm({ accounts }: { accounts: AccountOpt[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const [lines, setLines] = useState<Line[]>([
    { code: accounts[0]?.code ?? "", debit: "", credit: "" },
    { code: accounts[1]?.code ?? "", debit: "", credit: "" },
  ]);

  const totals = useMemo(() => {
    const d = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
    const c = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
    return { d, c, balanced: Math.abs(d - c) < 0.005 && d > 0 };
  }, [lines]);

  function update(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  return (
    <form action={createEntryAction} className="card p-4 space-y-4">
      <input type="hidden" name="sourceType" value="MANUAL" />
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="label">Date</label>
          <input className="input" type="date" name="date" defaultValue={today} required />
        </div>
        <div>
          <label className="label">Description</label>
          <input className="input" name="description" placeholder="Manual journal" required />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr>
              <th className="th">Account</th>
              <th className="th text-right">Debit</th>
              <th className="th text-right">Credit</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="td">
                  <select
                    name="lineCode"
                    className="input"
                    value={l.code}
                    onChange={(e) => update(i, { code: e.target.value })}
                  >
                    {accounts.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="td">
                  <input
                    className="input num text-right"
                    name="lineDebit"
                    type="number"
                    step="0.01"
                    min="0"
                    value={l.debit}
                    onChange={(e) => update(i, { debit: e.target.value, credit: "" })}
                  />
                </td>
                <td className="td">
                  <input
                    className="input num text-right"
                    name="lineCredit"
                    type="number"
                    step="0.01"
                    min="0"
                    value={l.credit}
                    onChange={(e) => update(i, { credit: e.target.value, debit: "" })}
                  />
                </td>
                <td className="td text-right">
                  {lines.length > 2 && (
                    <button type="button" className="text-expense text-xs" onClick={() => setLines((ls) => ls.filter((_, idx) => idx !== i))}>
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="td text-right">Totals</td>
              <td className="td text-right num">{totals.d.toFixed(2)}</td>
              <td className="td text-right num">{totals.c.toFixed(2)}</td>
              <td className="td"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <button type="button" className="btn-ghost" onClick={() => setLines((ls) => [...ls, { code: accounts[0]?.code ?? "", debit: "", credit: "" }])}>
          + Add line
        </button>
        <div className="flex items-center gap-3">
          <span className={`text-sm ${totals.balanced ? "text-income" : "text-expense"}`}>
            {totals.balanced ? "Balanced ✓" : `Out of balance by ${Math.abs(totals.d - totals.c).toFixed(2)}`}
          </span>
          <button className="btn-primary" disabled={!totals.balanced} type="submit">
            Post journal
          </button>
        </div>
      </div>
    </form>
  );
}
