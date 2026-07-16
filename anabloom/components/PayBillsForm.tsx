"use client";

import { useState } from "react";
import { payBillsAction } from "@/app/actions";

interface BillOpt {
  id: string;
  label: string;
  balance: number;
}

export default function PayBillsForm({ supplierId, bills }: { supplierId: string; bills: BillOpt[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(bills.map((b) => [b.id, ""])));

  if (bills.length === 0) return <p className="text-sm text-muted">No open bills to pay.</p>;

  const total = bills.reduce((s, b) => s + (parseFloat(amounts[b.id] || "0") || 0), 0);

  return (
    <form action={payBillsAction} className="space-y-2">
      <input type="hidden" name="supplierId" value={supplierId} />
      <div className="flex items-end gap-2">
        <div>
          <label className="label">Payment date</label>
          <input className="input" type="date" name="date" defaultValue={today} />
        </div>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            <th className="th">Bill</th>
            <th className="th text-right">Balance</th>
            <th className="th text-right">Pay now</th>
          </tr>
        </thead>
        <tbody>
          {bills.map((b) => (
            <tr key={b.id}>
              <td className="td">{b.label}</td>
              <td className="td text-right num">{b.balance.toFixed(2)}</td>
              <td className="td text-right">
                <input type="hidden" name="billId" value={b.id} />
                <input
                  className="input num w-28 text-right py-1"
                  name="payAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  max={b.balance}
                  value={amounts[b.id]}
                  onChange={(e) => setAmounts({ ...amounts, [b.id]: e.target.value })}
                  placeholder="0.00"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="text-primary text-xs"
          onClick={() => setAmounts(Object.fromEntries(bills.map((b) => [b.id, b.balance.toFixed(2)])))}
        >
          Pay all in full
        </button>
        <div className="flex items-center gap-3">
          <span className="text-sm">
            Total: <span className="num font-semibold">{total.toFixed(2)}</span>
          </span>
          <button className="btn-primary" disabled={total <= 0}>
            Record payment
          </button>
        </div>
      </div>
    </form>
  );
}
