import Link from "next/link";
import ConfirmButton from "@/components/ConfirmButton";
import { Money } from "@/components/Money";
import { createBillAction, payBillsAction, voidBillAction } from "@/app/actions";
import { getActiveCompany } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { listBills } from "@/lib/services/payables";

export const dynamic = "force-dynamic";

const STATUS_CLS: Record<string, string> = {
  OPEN: "bg-primary/10 text-primary",
  PARTIALLY_PAID: "bg-amber-100 text-amber-700",
  PAID: "bg-income/10 text-income",
  VOID: "bg-line text-muted",
};

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; supplier?: string; property?: string }>;
}) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const sp = await searchParams;
  const now = new Date();

  const [bills, suppliers, properties, expenseAccounts] = await Promise.all([
    listBills(company.id, { status: sp.status, supplierId: sp.supplier, propertyId: sp.property }),
    prisma.supplier.findMany({ where: { companyId: company.id }, orderBy: { name: "asc" } }),
    prisma.property.findMany({ where: { companyId: company.id }, orderBy: { name: "asc" } }),
    prisma.account.findMany({ where: { companyId: company.id, type: "EXPENSE", active: true }, orderBy: { code: "asc" } }),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Bills</h1>
          <p className="text-sm text-muted">{company.name}</p>
        </div>
        <Link href="/reports/ap-aging" className="btn-ghost no-print">
          AP aging →
        </Link>
      </div>

      {/* Filters */}
      <form method="get" className="card p-3 flex flex-wrap gap-3 items-end no-print">
        <div>
          <label className="label">Status</label>
          <select name="status" defaultValue={sp.status || ""} className="input">
            <option value="">All</option>
            {["OPEN", "PARTIALLY_PAID", "PAID", "VOID"].map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Supplier</label>
          <select name="supplier" defaultValue={sp.supplier || ""} className="input">
            <option value="">All</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
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
        <button className="btn-primary">Filter</button>
        <Link href="/bills" className="btn-ghost">
          Reset
        </Link>
      </form>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[840px]">
          <thead>
            <tr>
              <th className="th">Due</th>
              <th className="th">Supplier</th>
              <th className="th">Description</th>
              <th className="th">Ref</th>
              <th className="th text-right">Amount</th>
              <th className="th text-right">Balance</th>
              <th className="th">Status</th>
              <th className="th no-print"></th>
            </tr>
          </thead>
          <tbody>
            {bills.length === 0 && (
              <tr>
                <td className="td text-muted" colSpan={8}>
                  No bills match.
                </td>
              </tr>
            )}
            {bills.map((b) => {
              const overdue = b.balance > 0 && b.dueDate < now;
              return (
                <tr key={b.id} className={overdue ? "bg-expense/5" : ""}>
                  <td className="td whitespace-nowrap">
                    {b.dueDate.toISOString().slice(0, 10)}
                    {overdue && <span className="badge bg-expense/10 text-expense ml-1">overdue</span>}
                  </td>
                  <td className="td">
                    <Link href={`/suppliers/${b.supplierId}`} className="text-primary">
                      {b.supplierName}
                    </Link>
                  </td>
                  <td className="td">{b.description}</td>
                  <td className="td text-xs text-muted">{b.reference || "—"}</td>
                  <td className="td text-right num">{b.amount.toFixed(2)}</td>
                  <td className="td text-right num">{b.balance.toFixed(2)}</td>
                  <td className="td">
                    <span className={`badge ${STATUS_CLS[b.status]}`}>{b.status.replace("_", " ")}</span>
                  </td>
                  <td className="td no-print whitespace-nowrap">
                    {(b.status === "OPEN" || b.status === "PARTIALLY_PAID") && (
                      <form action={payBillsAction} className="inline">
                        <input type="hidden" name="supplierId" value={b.supplierId} />
                        <input type="hidden" name="billId" value={b.id} />
                        <input type="hidden" name="payAmount" value={b.balance.toFixed(2)} />
                        <button className="text-primary text-xs hover:underline mr-2">Pay full</button>
                      </form>
                    )}
                    {b.status === "OPEN" && (
                      <ConfirmButton action={voidBillAction} id={b.id} label="Void" message="Void this bill (reverses its posting)?" />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* New bill */}
      <details className="card p-4 no-print">
        <summary className="cursor-pointer font-medium text-primary">+ New bill (expense or asset on credit)</summary>
        {suppliers.length === 0 ? (
          <p className="text-sm text-expense mt-3">
            Add a supplier first —{" "}
            <Link href="/suppliers" className="underline">
              Suppliers
            </Link>
            .
          </p>
        ) : (
          <form action={createBillAction} className="mt-4 grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Supplier</label>
              <select className="input" name="supplierId" required>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Property (optional)</label>
              <select className="input" name="propertyId">
                <option value="">— none —</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Bill date</label>
              <input className="input" type="date" name="billDate" required />
            </div>
            <div>
              <label className="label">Due date (blank = supplier terms)</label>
              <input className="input" type="date" name="dueDate" />
            </div>
            <div>
              <label className="label">Reference (invoice no.)</label>
              <input className="input" name="reference" />
            </div>
            <div>
              <label className="label">Amount</label>
              <input className="input num" type="number" step="0.01" name="amount" required />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Description</label>
              <input className="input" name="description" required />
            </div>
            <div>
              <label className="label">Type</label>
              <select className="input" name="kind" defaultValue="expense">
                <option value="expense">Expense</option>
                <option value="asset">Asset purchase</option>
              </select>
            </div>
            <div>
              <label className="label">Expense account (for expenses)</label>
              <select className="input" name="accountCode" defaultValue="5900">
                {expenseAccounts.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.code} {a.name}
                  </option>
                ))}
                <option value="1500">1500 Property (asset)</option>
                <option value="1510">1510 Furniture (asset)</option>
                <option value="1520">1520 Equipment (asset)</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Attach invoice (image/PDF, optional)</label>
              <input className="text-sm" type="file" name="attachments" accept="image/*,application/pdf" multiple />
            </div>
            <div className="sm:col-span-2 flex justify-end">
              <button className="btn-primary">Create bill</button>
            </div>
          </form>
        )}
      </details>
    </div>
  );
}
