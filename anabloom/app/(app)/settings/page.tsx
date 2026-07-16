import ConfirmButton from "@/components/ConfirmButton";
import {
  changePasswordAction,
  deleteAllDataAction,
  lockPeriodAction,
  setCurrencyAction,
  unlockPeriodAction,
} from "@/app/actions";
import { prisma } from "@/lib/prisma";
import { getUser } from "@/lib/session";
import { yearMonth } from "@/lib/services/period";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getUser();
  const locks = await prisma.lockedPeriod.findMany({ where: { userId: user.id }, orderBy: { yearMonth: "desc" } });
  const thisMonth = yearMonth(new Date());

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="card p-4 space-y-3">
        <h2 className="font-semibold">Currency</h2>
        <form action={setCurrencyAction} className="flex gap-2 items-end">
          <div>
            <label className="label">Currency symbol</label>
            <input className="input w-24" name="currency" defaultValue={user.currency} maxLength={5} />
          </div>
          <button className="btn-primary">Save</button>
        </form>
      </div>

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

      <div className="card p-4 space-y-3">
        <h2 className="font-semibold">Accounting period locks</h2>
        <p className="text-sm text-muted">Locking a month prevents any entry in it from being created, edited, or deleted.</p>
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

      <div className="card p-4 space-y-3 border-expense/40">
        <h2 className="font-semibold text-expense">Danger zone</h2>
        <p className="text-sm text-muted">Permanently delete all your accounting data (properties, tenants, entries, assets, statements).</p>
        <form action={deleteAllDataAction} className="flex gap-2 items-end">
          <div>
            <label className="label">Type DELETE to confirm</label>
            <input className="input w-40" name="confirm" placeholder="DELETE" />
          </div>
          <button className="btn-danger">Delete all data</button>
        </form>
      </div>
    </div>
  );
}
