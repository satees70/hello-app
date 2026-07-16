import Link from "next/link";
import { notFound } from "next/navigation";
import { Money } from "@/components/Money";
import PayBillsForm from "@/components/PayBillsForm";
import { updateSupplierAction } from "@/app/actions";
import { getActiveCompany } from "@/lib/company";
import { formatMoney } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { listBills } from "@/lib/services/payables";

export const dynamic = "force-dynamic";

const STATUS_CLS: Record<string, string> = {
  OPEN: "bg-primary/10 text-primary",
  PARTIALLY_PAID: "bg-amber-100 text-amber-700",
  PAID: "bg-income/10 text-income",
  VOID: "bg-line text-muted",
};

export default async function SupplierDetail({ params }: { params: Promise<{ id: string }> }) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const { id } = await params;
  const supplier = await prisma.supplier.findFirst({ where: { id, companyId: company.id } });
  if (!supplier) notFound();

  const bills = await listBills(company.id, { supplierId: id });
  const openBills = bills.filter((b) => b.status === "OPEN" || b.status === "PARTIALLY_PAID");
  const owed = openBills.reduce((s, b) => s + b.balance, 0);
  const payments = await prisma.billPayment.findMany({
    where: { bill: { supplierId: id, companyId: company.id } },
    include: { bill: true },
    orderBy: { date: "desc" },
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{supplier.name}</h1>
          <p className="text-sm text-muted">
            Balance owed <Money value={owed} symbol={sym} colorNegative={false} />
          </p>
        </div>
        <div className="flex gap-2 no-print">
          <Link href={`/suppliers/${id}/statement`} className="btn-ghost">
            Statement
          </Link>
          <Link href="/suppliers" className="btn-ghost">
            ← Suppliers
          </Link>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="card p-4 no-print">
          <h2 className="font-semibold mb-2">Details</h2>
          <form action={updateSupplierAction} className="space-y-2">
            <input type="hidden" name="id" value={supplier.id} />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Name</label>
                <input className="input" name="name" defaultValue={supplier.name} required />
              </div>
              <div>
                <label className="label">Reg. no.</label>
                <input className="input" name="registrationNo" defaultValue={supplier.registrationNo ?? ""} />
              </div>
              <div>
                <label className="label">Phone</label>
                <input className="input" name="phone" defaultValue={supplier.phone ?? ""} />
              </div>
              <div>
                <label className="label">Email</label>
                <input className="input" name="email" defaultValue={supplier.email ?? ""} />
              </div>
              <div>
                <label className="label">Terms (days)</label>
                <input className="input num" type="number" name="defaultTermsDays" defaultValue={supplier.defaultTermsDays} />
              </div>
              <div>
                <label className="label">Notes</label>
                <input className="input" name="notes" defaultValue={supplier.notes ?? ""} />
              </div>
            </div>
            <div className="flex justify-end">
              <button className="btn-primary py-1">Save</button>
            </div>
          </form>
        </div>

        <div className="card p-4">
          <h2 className="font-semibold mb-2">Record payment</h2>
          <PayBillsForm
            supplierId={supplier.id}
            bills={openBills.map((b) => ({ id: b.id, label: `${b.description} (due ${b.dueDate.toISOString().slice(0, 10)})`, balance: b.balance }))}
          />
        </div>
      </div>

      <div className="card overflow-x-auto">
        <div className="p-3 border-b border-line font-semibold">Bills</div>
        <table className="w-full min-w-[560px]">
          <thead>
            <tr>
              <th className="th">Bill date</th>
              <th className="th">Due</th>
              <th className="th">Description</th>
              <th className="th text-right">Amount</th>
              <th className="th text-right">Balance</th>
              <th className="th">Status</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr key={b.id}>
                <td className="td whitespace-nowrap">{b.billDate.toISOString().slice(0, 10)}</td>
                <td className="td whitespace-nowrap">{b.dueDate.toISOString().slice(0, 10)}</td>
                <td className="td">{b.description}</td>
                <td className="td text-right num">{formatMoney(b.amount, sym)}</td>
                <td className="td text-right num">{formatMoney(b.balance, sym)}</td>
                <td className="td">
                  <span className={`badge ${STATUS_CLS[b.status]}`}>{b.status.replace("_", " ")}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card p-4">
        <h2 className="font-semibold mb-2">Payment history</h2>
        {payments.length === 0 ? (
          <p className="text-sm text-muted">No payments yet.</p>
        ) : (
          <table className="w-full">
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="td whitespace-nowrap">{p.date.toISOString().slice(0, 10)}</td>
                  <td className="td">{p.bill.description}</td>
                  <td className="td text-right num">{formatMoney(p.amount.toString(), sym)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
