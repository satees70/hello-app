import {
  changePasswordAction,
  createCompanyAction,
  deleteCompanyDataAction,
  lockPeriodAction,
  setActiveCompanyAction,
  unlockPeriodAction,
  updateCompanyAction,
} from "@/app/actions";
import { getActiveCompany } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { yearMonth } from "@/lib/services/period";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { company, companies } = await getActiveCompany();
  const locks = await prisma.lockedPeriod.findMany({ where: { companyId: company.id }, orderBy: { yearMonth: "desc" } });
  const thisMonth = yearMonth(new Date());

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Companies */}
      <div className="card p-4 space-y-4">
        <h2 className="font-semibold">Companies</h2>
        {companies.map((c) => (
          <form key={c.id} action={updateCompanyAction} className="border border-line rounded-md p-3 space-y-2">
            <input type="hidden" name="id" value={c.id} />
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {c.name}
                {c.id === company.id && <span className="badge bg-primary/10 text-primary ml-2">active</span>}
              </span>
              {c.id !== company.id && (
                <SwitchButton id={c.id} />
              )}
            </div>
            <div className="grid sm:grid-cols-3 gap-2">
              <div>
                <label className="label">Name</label>
                <input className="input" name="name" defaultValue={c.name} required />
              </div>
              <div>
                <label className="label">Registration no.</label>
                <input className="input" name="registrationNo" defaultValue={c.registrationNo ?? ""} />
              </div>
              <div>
                <label className="label">Currency</label>
                <input className="input" name="currency" defaultValue={c.currency} maxLength={5} />
              </div>
            </div>
            <details>
              <summary className="cursor-pointer text-primary text-xs font-medium">
                Landlord details (for tenancy agreements)
              </summary>
              <div className="mt-2 space-y-2">
                <div>
                  <label className="label">Address</label>
                  <input className="input" name="address" defaultValue={c.address ?? ""} />
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div>
                    <label className="label">Phone / H/P</label>
                    <input className="input" name="phone" defaultValue={c.phone ?? ""} />
                  </div>
                  <div>
                    <label className="label">Signatory name</label>
                    <input className="input" name="signatoryName" defaultValue={c.signatoryName ?? ""} />
                  </div>
                  <div>
                    <label className="label">Signatory NRIC</label>
                    <input className="input" name="signatoryNric" defaultValue={c.signatoryNric ?? ""} />
                  </div>
                  <div>
                    <label className="label">Bank name</label>
                    <input className="input" name="bankName" defaultValue={c.bankName ?? ""} />
                  </div>
                  <div>
                    <label className="label">Bank account no.</label>
                    <input className="input" name="bankAccountNo" defaultValue={c.bankAccountNo ?? ""} />
                  </div>
                </div>
              </div>
            </details>
            <div className="flex justify-end">
              <button className="btn-primary py-1">Save</button>
            </div>
          </form>
        ))}

        <details>
          <summary className="cursor-pointer text-primary text-sm font-medium">+ Add another company</summary>
          <form action={createCompanyAction} className="mt-3 grid sm:grid-cols-3 gap-2">
            <div>
              <label className="label">Name</label>
              <input className="input" name="name" required />
            </div>
            <div>
              <label className="label">Registration no.</label>
              <input className="input" name="registrationNo" />
            </div>
            <div>
              <label className="label">Currency</label>
              <input className="input" name="currency" defaultValue="RM" maxLength={5} />
            </div>
            <div className="sm:col-span-3 flex justify-end">
              <button className="btn-primary">Create company &amp; seed accounts</button>
            </div>
          </form>
        </details>
      </div>

      {/* Change password */}
      <div className="card p-4 space-y-3">
        <h2 className="font-semibold">Change password</h2>
        <form action={changePasswordAction} className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Current password</label>
            <input className="input" type="password" name="current" required />
          </div>
          <div>
            <label className="label">New password</label>
            <input className="input" type="password" name="next" required minLength={6} />
          </div>
          <div className="sm:col-span-2">
            <button className="btn-primary">Update password</button>
          </div>
        </form>
      </div>

      {/* Period locks (active company) */}
      <div className="card p-4 space-y-3">
        <h2 className="font-semibold">Accounting period locks — {company.name}</h2>
        <p className="text-sm text-muted">Locking a month prevents any entry in it (for this company) from being created, edited, or deleted.</p>
        <form action={lockPeriodAction} className="flex gap-2 items-end">
          <div>
            <label className="label">Lock month</label>
            <input className="input" type="month" name="yearMonth" defaultValue={thisMonth} required />
          </div>
          <button className="btn-primary">Lock</button>
        </form>
        {locks.length > 0 && (
          <table className="w-full mt-2">
            <tbody>
              {locks.map((l) => (
                <tr key={l.id}>
                  <td className="td num">🔒 {l.yearMonth}</td>
                  <td className="td text-right">
                    <form action={unlockPeriodAction} className="flex gap-1 justify-end items-center">
                      <input type="hidden" name="yearMonth" value={l.yearMonth} />
                      <input className="input py-1 w-28" name="confirm" placeholder={`type ${l.yearMonth}`} />
                      <button className="text-expense text-xs">Unlock</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Danger zone */}
      <div className="card p-4 space-y-3 border-expense/40">
        <h2 className="font-semibold text-expense">Danger zone — {company.name}</h2>
        <p className="text-sm text-muted">
          Permanently delete all accounting data for <strong>{company.name}</strong> (properties, tenants, entries, assets,
          statements). The company and its chart of accounts remain.
        </p>
        <form action={deleteCompanyDataAction} className="flex gap-2 items-end">
          <div>
            <label className="label">Type the company name to confirm</label>
            <input className="input w-64" name="confirm" placeholder={company.name} />
          </div>
          <button className="btn-danger">Delete company data</button>
        </form>
      </div>
    </div>
  );
}

function SwitchButton({ id }: { id: string }) {
  return (
    <form action={setActiveCompanyAction}>
      <input type="hidden" name="id" value={id} />
      <button className="text-primary text-xs hover:underline">Make active</button>
    </form>
  );
}
