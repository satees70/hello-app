import ConfirmButton from "@/components/ConfirmButton";
import { addAccountAction, deactivateAccountAction, renameAccountAction } from "@/app/actions";
import { ACCOUNT_TYPES } from "@/lib/enums";
import { prisma } from "@/lib/prisma";
import { getActiveCompany } from "@/lib/company";

export const dynamic = "force-dynamic";

const SECTIONS: { type: string; title: string }[] = [
  { type: "ASSET", title: "Assets" },
  { type: "LIABILITY", title: "Liabilities" },
  { type: "EQUITY", title: "Equity" },
  { type: "INCOME", title: "Income" },
  { type: "EXPENSE", title: "Expenses" },
];

export default async function AccountsPage() {
  const { company } = await getActiveCompany();
  const accounts = await prisma.account.findMany({
    where: { companyId: company.id },
    include: { _count: { select: { lines: true } } },
    orderBy: { code: "asc" },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Chart of Accounts</h1>

      {SECTIONS.map((sec) => (
        <div key={sec.type} className="card">
          <h2 className="font-semibold p-3 border-b border-line">{sec.title}</h2>
          <table className="w-full">
            <tbody>
              {accounts
                .filter((a) => a.type === sec.type && a.active)
                .map((a) => (
                  <tr key={a.id}>
                    <td className="td num w-16">{a.code}</td>
                    <td className="td">
                      <form action={renameAccountAction} className="flex gap-2 items-center">
                        <input type="hidden" name="id" value={a.id} />
                        <input className="input py-1 max-w-xs" name="name" defaultValue={a.name} />
                        <button className="text-primary text-xs no-print">Save</button>
                        {a.isSystem && <span className="badge bg-line text-muted">system</span>}
                      </form>
                    </td>
                    <td className="td text-right text-xs text-muted">{a._count.lines} postings</td>
                    <td className="td text-right no-print">
                      {!a.isSystem && a._count.lines === 0 && (
                        <ConfirmButton action={deactivateAccountAction} id={a.id} label="Deactivate" message={`Deactivate ${a.name}?`} />
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}

      <details className="card p-4 no-print">
        <summary className="cursor-pointer font-medium text-primary">+ Add account</summary>
        <form action={addAccountAction} className="mt-4 grid sm:grid-cols-3 gap-3">
          <div>
            <label className="label">Code</label>
            <input className="input num" name="code" placeholder="e.g. 5050" required />
          </div>
          <div>
            <label className="label">Name</label>
            <input className="input" name="name" required />
          </div>
          <div>
            <label className="label">Type</label>
            <select className="input" name="type">
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-3 flex justify-end">
            <button className="btn-primary">Add account</button>
          </div>
        </form>
        <p className="text-xs text-muted mt-2">
          Add extra accounts within a range (e.g. another 5xxx expense). System accounts cannot be deleted; any account with
          postings cannot be deactivated.
        </p>
      </details>
    </div>
  );
}
