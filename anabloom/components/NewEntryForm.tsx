"use client";

import { useState } from "react";
import { createEntryAction } from "@/app/actions";
import { SourceType } from "@/lib/enums";

interface Opt {
  id: string;
  label: string;
}
interface AccountOpt {
  code: string;
  name: string;
}

const TYPES: { value: SourceType; label: string }[] = [
  { value: "RENT_RECEIVED", label: "Rent received" },
  { value: "RENT_INVOICED", label: "Rent invoiced (owed)" },
  { value: "RENT_PAYMENT", label: "Rent payment vs receivable" },
  { value: "OTHER_INCOME_RECEIVED", label: "Other income received" },
  { value: "EXPENSE_PAID", label: "Expense paid" },
  { value: "EXPENSE_ON_CREDIT", label: "Expense on credit (bill)" },
  { value: "PAY_BILL", label: "Pay a bill" },
  { value: "DEPOSIT_RECEIVED", label: "Tenant deposit received" },
  { value: "DEPOSIT_REFUNDED", label: "Tenant deposit refunded" },
  { value: "OWNER_CAPITAL", label: "Owner puts money in" },
  { value: "OWNER_DRAWINGS", label: "Owner takes money out" },
  { value: "LOAN_RECEIVED", label: "Loan received" },
  { value: "LOAN_REPAYMENT", label: "Loan repayment" },
];

const LEASE_TYPES: SourceType[] = ["RENT_RECEIVED", "RENT_INVOICED", "RENT_PAYMENT", "DEPOSIT_RECEIVED", "DEPOSIT_REFUNDED"];

export default function NewEntryForm({
  properties,
  leases,
  incomeAccounts,
  expenseAccounts,
}: {
  properties: Opt[];
  leases: Opt[];
  incomeAccounts: AccountOpt[];
  expenseAccounts: AccountOpt[];
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<SourceType>("RENT_RECEIVED");
  const today = new Date().toISOString().slice(0, 10);

  const showLease = LEASE_TYPES.includes(type);
  const showIncome = type === "OTHER_INCOME_RECEIVED";
  const showExpense = type === "EXPENSE_PAID" || type === "EXPENSE_ON_CREDIT";
  const showLoan = type === "LOAN_REPAYMENT";
  const showAmount = !showLoan;

  return (
    <div className="card p-4 no-print">
      <button className="btn-primary" onClick={() => setOpen(!open)}>
        {open ? "Close" : "+ New entry"}
      </button>
      {open && (
        <form action={createEntryAction} className="mt-4 grid sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className="label">Transaction type</label>
            <select name="sourceType" className="input" value={type} onChange={(e) => setType(e.target.value as SourceType)}>
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Date</label>
            <input className="input" type="date" name="date" defaultValue={today} required />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" name="description" placeholder="e.g. February rent" />
          </div>

          {showLease && (
            <div className="sm:col-span-2">
              <label className="label">Lease (sets property & rent)</label>
              <select name="leaseId" className="input">
                <option value="">— none —</option>
                {leases.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {!showLease && (
            <div>
              <label className="label">Property (optional)</label>
              <select name="propertyId" className="input">
                <option value="">— company level —</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showIncome && (
            <div>
              <label className="label">Income account</label>
              <select name="incomeAccountCode" className="input">
                {incomeAccounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showExpense && (
            <div>
              <label className="label">Expense account</label>
              <select name="expenseAccountCode" className="input">
                {expenseAccounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showAmount && (
            <div>
              <label className="label">Amount</label>
              <input className="input num" type="number" step="0.01" min="0" name="amount" required />
            </div>
          )}

          {showLoan && (
            <>
              <div>
                <label className="label">Principal</label>
                <input className="input num" type="number" step="0.01" min="0" name="principal" />
              </div>
              <div>
                <label className="label">Interest</label>
                <input className="input num" type="number" step="0.01" min="0" name="interest" />
              </div>
            </>
          )}

          <div className="sm:col-span-2">
            <label className="label">Receipts (images/PDF, ≤10 MB each — optional)</label>
            <input className="text-sm" type="file" name="attachments" accept="image/*,application/pdf" multiple />
          </div>

          <div className="sm:col-span-2 flex justify-end">
            <button className="btn-primary" type="submit">
              Save entry
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
