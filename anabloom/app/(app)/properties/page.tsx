import ConfirmButton from "@/components/ConfirmButton";
import { Money } from "@/components/Money";
import { createPropertyAction, deletePropertyAction, recordRentPaymentAction } from "@/app/actions";
import { prisma } from "@/lib/prisma";
import { profitAndLoss } from "@/lib/reports";
import { getUser } from "@/lib/session";
import { getLedgerLines } from "@/lib/services/ledger";

export const dynamic = "force-dynamic";

export default async function PropertiesPage() {
  const user = await getUser();
  const sym = user.currency;
  const [properties, lines] = await Promise.all([
    prisma.property.findMany({ where: { userId: user.id }, orderBy: { name: "asc" }, include: { leases: { where: { status: "ACTIVE" }, include: { tenant: true } } } }),
    getLedgerLines(user.id),
  ]);

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Properties</h1>

      <details className="card p-4 no-print">
        <summary className="cursor-pointer font-medium text-primary">+ Add property</summary>
        <form action={createPropertyAction} className="mt-4 grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" name="name" required />
          </div>
          <div>
            <label className="label">Monthly rent</label>
            <input className="input num" type="number" step="0.01" name="monthlyRent" defaultValue="0" />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Address</label>
            <input className="input" name="address" />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Notes</label>
            <input className="input" name="notes" />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <button className="btn-primary">Add property</button>
          </div>
        </form>
      </details>

      {properties.length === 0 ? (
        <p className="card p-6 text-center text-muted">No properties yet. Add your first one above.</p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {properties.map((p) => {
            const net = Number(profitAndLoss(lines, undefined, undefined, p.id).net);
            const lease = p.leases[0];
            return (
              <div key={p.id} className="card p-4 space-y-2">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="font-semibold">{p.name}</h3>
                    {p.address && <p className="text-xs text-muted">{p.address}</p>}
                  </div>
                  <ConfirmButton action={deletePropertyAction} id={p.id} message={`Delete ${p.name}?`} />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Monthly rent</span>
                  <Money value={p.monthlyRent.toString()} symbol={sym} colorNegative={false} />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Net to date</span>
                  <Money value={net} symbol={sym} />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Tenant</span>
                  <span>{lease ? lease.tenant.name : "—"}</span>
                </div>
                <form action={recordRentPaymentAction} className="pt-2 border-t border-line no-print flex gap-2 items-end">
                  {lease ? (
                    <>
                      <input type="hidden" name="leaseId" value={lease.id} />
                      <input type="hidden" name="sourceType" value="RENT_RECEIVED" />
                      <input type="hidden" name="description" value={`Rent — ${p.name}`} />
                      <div className="flex-1">
                        <label className="label">Record rent received</label>
                        <input className="input num" type="number" step="0.01" name="amount" defaultValue={Number(lease.monthlyRent).toFixed(2)} />
                      </div>
                      <button className="btn-primary">Record</button>
                    </>
                  ) : (
                    <p className="text-xs text-muted">Add an active lease to record rent.</p>
                  )}
                </form>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
