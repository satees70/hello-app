import ConfirmButton from "@/components/ConfirmButton";
import { Money } from "@/components/Money";
import { createAssetAction, disposeAssetAction, runDepreciationAction } from "@/app/actions";
import { prisma } from "@/lib/prisma";
import { getUser } from "@/lib/session";
import { yearMonth } from "@/lib/services/period";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const user = await getUser();
  const sym = user.currency;
  const [assets, properties] = await Promise.all([
    prisma.fixedAsset.findMany({ where: { userId: user.id }, include: { property: true }, orderBy: { purchaseDate: "desc" } }),
    prisma.property.findMany({ where: { userId: user.id }, orderBy: { name: "asc" } }),
  ]);

  // accumulated depreciation per asset
  const dep = await prisma.journalEntry.findMany({
    where: { userId: user.id, sourceType: "DEPRECIATION", fixedAssetId: { not: null } },
    include: { lines: { include: { account: true } } },
  });
  const accByAsset = new Map<string, number>();
  for (const e of dep) {
    if (!e.fixedAssetId) continue;
    for (const l of e.lines) if (l.account.code === "1590") accByAsset.set(e.fixedAssetId, (accByAsset.get(e.fixedAssetId) ?? 0) + Number(l.credit));
  }

  const thisMonth = yearMonth(new Date());
  const ASSET_ACCOUNTS = [
    ["1500", "Property (buildings)"],
    ["1510", "Furniture & fittings"],
    ["1520", "Equipment"],
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold">Fixed Assets</h1>
        <form action={runDepreciationAction} className="flex items-end gap-2 no-print">
          <div>
            <label className="label">Run depreciation up to</label>
            <input className="input" type="month" name="upTo" defaultValue={thisMonth} />
          </div>
          <button className="btn-primary">Run depreciation</button>
        </form>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr>
              <th className="th">Asset</th>
              <th className="th">Property</th>
              <th className="th">Purchased</th>
              <th className="th text-right">Cost</th>
              <th className="th text-right">Accum. dep.</th>
              <th className="th text-right">Net book value</th>
              <th className="th no-print"></th>
            </tr>
          </thead>
          <tbody>
            {assets.length === 0 && (
              <tr>
                <td className="td text-muted" colSpan={7}>
                  No assets yet. Add one below.
                </td>
              </tr>
            )}
            {assets.map((a) => {
              const acc = accByAsset.get(a.id) ?? 0;
              const nbv = Number(a.cost) - acc;
              return (
                <tr key={a.id}>
                  <td className="td">
                    {a.name} {a.disposedAt && <span className="badge bg-line text-muted ml-1">Disposed</span>}
                  </td>
                  <td className="td">{a.property?.name || "—"}</td>
                  <td className="td whitespace-nowrap">{a.purchaseDate.toISOString().slice(0, 10)}</td>
                  <td className="td text-right"><Money value={a.cost.toString()} symbol={sym} colorNegative={false} /></td>
                  <td className="td text-right"><Money value={acc} symbol={sym} colorNegative={false} /></td>
                  <td className="td text-right font-semibold"><Money value={nbv} symbol={sym} colorNegative={false} /></td>
                  <td className="td no-print">
                    {!a.disposedAt && (
                      <details>
                        <summary className="cursor-pointer text-xs text-primary">Dispose</summary>
                        <form action={disposeAssetAction} className="mt-2 flex gap-1 items-end">
                          <input type="hidden" name="id" value={a.id} />
                          <div>
                            <label className="label">Proceeds</label>
                            <input className="input num w-24 py-1" type="number" step="0.01" name="proceeds" defaultValue="0" />
                          </div>
                          <div>
                            <label className="label">Date</label>
                            <input className="input py-1" type="date" name="date" />
                          </div>
                          <button className="btn-danger py-1">Dispose</button>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <details className="card p-4 no-print">
        <summary className="cursor-pointer font-medium text-primary">+ Add asset</summary>
        <form action={createAssetAction} className="mt-4 grid sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" name="name" required />
          </div>
          <div>
            <label className="label">Linked property (optional)</label>
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
            <label className="label">Asset account</label>
            <select className="input" name="assetAccountCode" defaultValue="1510">
              {ASSET_ACCOUNTS.map(([c, n]) => (
                <option key={c} value={c}>
                  {c} {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Cost</label>
            <input className="input num" type="number" step="0.01" name="cost" required />
          </div>
          <div>
            <label className="label">Purchase date</label>
            <input className="input" type="date" name="purchaseDate" required />
          </div>
          <div>
            <label className="label">Useful life (months)</label>
            <input className="input num" type="number" name="usefulLifeMonths" defaultValue="60" />
          </div>
          <div>
            <label className="label">Salvage value</label>
            <input className="input num" type="number" step="0.01" name="salvageValue" defaultValue="0" />
          </div>
          <div>
            <label className="label">Funding</label>
            <select className="input" name="fundingAccountCode" defaultValue="1000">
              <option value="1000">Cash at bank</option>
              <option value="2200">Accounts payable</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" name="postPurchase" defaultChecked /> Post the purchase journal now
          </label>
          <div className="sm:col-span-2 flex justify-end">
            <button className="btn-primary">Add asset</button>
          </div>
        </form>
      </details>
    </div>
  );
}
