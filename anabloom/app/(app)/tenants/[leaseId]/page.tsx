import Link from "next/link";
import { notFound } from "next/navigation";
import { Money } from "@/components/Money";
import { endLeaseAction, renewLeaseAction, setStampedDateAction, toggleAutoInvoiceAction } from "@/app/actions";
import { prisma } from "@/lib/prisma";
import { getActiveCompany } from "@/lib/company";
import { getAgingReport } from "@/lib/services/arrears";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function LeaseDetail({ params }: { params: Promise<{ leaseId: string }> }) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const { leaseId } = await params;
  const lease = await prisma.lease.findFirst({
    where: { id: leaseId, companyId: company.id },
    include: { tenant: true, property: true, documents: { orderBy: { uploadedAt: "desc" } }, renewals: true, renewedFrom: true },
  });
  if (!lease) notFound();

  const aging = await getAgingReport(company.id, new Date());
  const ar = aging.rows.find((r) => r.leaseId === lease.id);
  const storage = getStorage();
  const docs = await Promise.all(
    lease.documents.map(async (d) => ({ ...d, url: await storage.signedUrl(d.storagePath) }))
  );
  const daysRemaining = lease.endDate ? Math.ceil((lease.endDate.getTime() - Date.now()) / 86400000) : null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{lease.tenant.name}</h1>
          <p className="text-muted text-sm">{lease.property.name}</p>
        </div>
        <div className="flex gap-2 no-print">
          <Link href={`/tenants/${lease.id}/statement`} className="btn-ghost">
            Statement
          </Link>
          <Link href="/tenants" className="btn-ghost">
            ← All leases
          </Link>
        </div>
      </div>

      {!lease.stampedDate && lease.status === "ACTIVE" && (
        <div className="card p-3 bg-amber-50 border-amber-200 text-amber-800 text-sm">
          ⚠️ This tenancy agreement is <strong>not stamped</strong>. Record the stamp duty payment as an expense and set the stamped date below.
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="card p-4 space-y-2 text-sm">
          <h2 className="font-semibold mb-1">Lease terms</h2>
          <Row label="Status" value={lease.status} />
          <Row label="Rent" value={<Money value={lease.monthlyRent.toString()} symbol={sym} colorNegative={false} />} />
          <Row label="Due day" value={String(lease.dueDay)} />
          <Row label="Deposit" value={<Money value={lease.depositAmount.toString()} symbol={sym} colorNegative={false} />} />
          <Row label="Start" value={lease.startDate.toISOString().slice(0, 10)} />
          <Row label="End" value={lease.endDate ? lease.endDate.toISOString().slice(0, 10) : "Month-to-month"} />
          {daysRemaining !== null && <Row label="Days remaining" value={daysRemaining < 0 ? "Expired" : String(daysRemaining)} />}
          <Row label="Signed" value={lease.signedDate ? lease.signedDate.toISOString().slice(0, 10) : "—"} />
          <Row label="Stamped" value={lease.stampedDate ? lease.stampedDate.toISOString().slice(0, 10) : "Not stamped"} />
          <Row label="Outstanding AR" value={<Money value={ar ? ar.total.toString() : 0} symbol={sym} colorNegative={false} />} />
          <form action={toggleAutoInvoiceAction} className="pt-2 no-print">
            <input type="hidden" name="id" value={lease.id} />
            <button className="text-primary text-xs">
              Auto-invoice: <strong>{lease.autoInvoice ? "ON" : "OFF"}</strong> — toggle
            </button>
          </form>
        </div>

        <div className="card p-4 space-y-3 no-print">
          <h2 className="font-semibold">Set stamped date</h2>
          <form action={setStampedDateAction} className="flex gap-2 items-end">
            <input type="hidden" name="id" value={lease.id} />
            <input className="input" type="date" name="stampedDate" defaultValue={lease.stampedDate?.toISOString().slice(0, 10)} />
            <button className="btn-primary">Save</button>
          </form>

          <h2 className="font-semibold pt-2">Term history</h2>
          <ul className="text-sm space-y-1">
            {lease.renewedFrom && (
              <li>
                ← Renewed from{" "}
                <Link href={`/tenants/${lease.renewedFrom.id}`} className="text-primary">
                  earlier term ({lease.renewedFrom.startDate.toISOString().slice(0, 10)})
                </Link>
              </li>
            )}
            <li className="font-medium">• This term ({lease.startDate.toISOString().slice(0, 10)})</li>
            {lease.renewals.map((r) => (
              <li key={r.id}>
                →{" "}
                <Link href={`/tenants/${r.id}`} className="text-primary">
                  Renewal ({r.startDate.toISOString().slice(0, 10)})
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Documents */}
      <div className="card p-4">
        <h2 className="font-semibold mb-3">Tenancy documents</h2>
        {docs.length === 0 ? (
          <p className="text-sm text-muted mb-3">No documents uploaded yet.</p>
        ) : (
          <ul className="mb-3 divide-y divide-line">
            {docs.map((d) => (
              <li key={d.id} className="py-2 flex items-center justify-between text-sm">
                <span>
                  <span className="badge bg-primary/10 text-primary mr-2">{d.label}</span>
                  <a href={d.url} target="_blank" rel="noreferrer" className="text-primary underline">
                    {d.fileName}
                  </a>
                  <span className="text-muted ml-2">({(d.sizeBytes / 1024).toFixed(0)} KB)</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <form action={`/api/leases/${lease.id}/documents`} method="post" encType="multipart/form-data" className="flex flex-wrap gap-2 items-end no-print">
          <div>
            <label className="label">Label</label>
            <select name="label" className="input">
              <option>Signed tenancy agreement</option>
              <option>Stamping certificate</option>
              <option>Inventory checklist</option>
              <option>Other</option>
            </select>
          </div>
          <div>
            <label className="label">File (image/PDF, ≤10MB)</label>
            <input type="file" name="file" accept="image/*,application/pdf" required className="text-sm" />
          </div>
          <button className="btn-primary">Upload</button>
        </form>
      </div>

      {/* Renew + End */}
      {lease.status === "ACTIVE" && (
        <div className="grid sm:grid-cols-2 gap-4 no-print">
          <details className="card p-4">
            <summary className="cursor-pointer font-medium text-primary">Renew lease</summary>
            <form action={renewLeaseAction} className="mt-3 space-y-2">
              <input type="hidden" name="leaseId" value={lease.id} />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">New start</label>
                  <input className="input" type="date" name="startDate" required />
                </div>
                <div>
                  <label className="label">New end</label>
                  <input className="input" type="date" name="endDate" />
                </div>
              </div>
              <div>
                <label className="label">New monthly rent</label>
                <input className="input num" type="number" step="0.01" name="monthlyRent" defaultValue={Number(lease.monthlyRent).toFixed(2)} required />
              </div>
              <p className="text-xs text-muted">Deposit ({Number(lease.depositAmount).toFixed(2)}) carries forward automatically.</p>
              <button className="btn-primary">Create renewal</button>
            </form>
          </details>

          <details className="card p-4">
            <summary className="cursor-pointer font-medium text-expense">End lease</summary>
            <form action={endLeaseAction} className="mt-3 space-y-2">
              <input type="hidden" name="leaseId" value={lease.id} />
              <div>
                <label className="label">End date</label>
                <input className="input" type="date" name="endDate" required />
              </div>
              <div>
                <label className="label">Deposit disposition</label>
                <select name="deposit" className="input">
                  <option value="refund">Refund to tenant</option>
                  <option value="apply">Apply against arrears</option>
                  <option value="forfeit">Forfeit to other income</option>
                  <option value="none">No deposit action</option>
                </select>
              </div>
              <button className="btn-danger">End lease</button>
            </form>
          </details>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span>{value}</span>
    </div>
  );
}
