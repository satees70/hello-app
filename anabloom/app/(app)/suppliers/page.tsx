import Link from "next/link";
import { Money } from "@/components/Money";
import { createSupplierAction } from "@/app/actions";
import { getActiveCompany } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { supplierBalances } from "@/lib/services/payables";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const [suppliers, balances] = await Promise.all([
    prisma.supplier.findMany({ where: { companyId: company.id }, orderBy: { name: "asc" } }),
    supplierBalances(company.id),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Suppliers</h1>
          <p className="text-sm text-muted">{company.name}</p>
        </div>
        <Link href="/bills" className="btn-ghost no-print">
          Bills →
        </Link>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[560px]">
          <thead>
            <tr>
              <th className="th">Supplier</th>
              <th className="th">Terms</th>
              <th className="th">Contact</th>
              <th className="th text-right">Balance owed</th>
            </tr>
          </thead>
          <tbody>
            {suppliers.length === 0 && (
              <tr>
                <td className="td text-muted" colSpan={4}>
                  No suppliers yet. Add one below.
                </td>
              </tr>
            )}
            {suppliers.map((sp) => (
              <tr key={sp.id}>
                <td className="td">
                  <Link href={`/suppliers/${sp.id}`} className="text-primary font-medium">
                    {sp.name}
                  </Link>
                  {sp.registrationNo && <span className="text-xs text-muted ml-2">({sp.registrationNo})</span>}
                </td>
                <td className="td">{sp.defaultTermsDays} days</td>
                <td className="td text-sm text-muted">{sp.email || sp.phone || "—"}</td>
                <td className="td text-right">
                  <Money value={balances.get(sp.id) ?? 0} symbol={sym} colorNegative={false} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="card p-4 no-print">
        <summary className="cursor-pointer font-medium text-primary">+ Add supplier</summary>
        <form action={createSupplierAction} className="mt-4 grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" name="name" required />
          </div>
          <div>
            <label className="label">Registration no.</label>
            <input className="input" name="registrationNo" />
          </div>
          <div>
            <label className="label">Phone</label>
            <input className="input" name="phone" />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" name="email" />
          </div>
          <div>
            <label className="label">Default payment terms (days)</label>
            <input className="input num" type="number" name="defaultTermsDays" defaultValue="30" />
          </div>
          <div>
            <label className="label">Notes</label>
            <input className="input" name="notes" />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button className="btn-primary">Add supplier</button>
          </div>
        </form>
      </details>
    </div>
  );
}
