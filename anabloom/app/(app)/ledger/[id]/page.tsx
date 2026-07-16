import Link from "next/link";
import { notFound } from "next/navigation";
import ConfirmButton from "@/components/ConfirmButton";
import { Money } from "@/components/Money";
import { deleteAttachmentAction, deleteEntryAction } from "@/app/actions";
import { SOURCE_TYPE_LABELS, SourceType } from "@/lib/enums";
import { prisma } from "@/lib/prisma";
import { getActiveCompany } from "@/lib/company";
import { getStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function EntryDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { company } = await getActiveCompany();
  const sym = company.currency;
  const { id } = await params;
  const sp = await searchParams;
  const entry = await prisma.journalEntry.findFirst({
    where: { id, companyId: company.id },
    include: { lines: { include: { account: true } }, property: true, lease: { include: { tenant: true } }, attachments: { orderBy: { uploadedAt: "asc" } } },
  });
  if (!entry) notFound();

  const storage = getStorage();
  const atts = await Promise.all(
    entry.attachments.map(async (a) => ({ ...a, url: await storage.signedUrl(a.storagePath) }))
  );
  const totalDebit = entry.lines.reduce((s, l) => s + Number(l.debit), 0);

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/ledger" className="text-sm text-primary no-print">
            ← Ledger
          </Link>
          <h1 className="text-2xl font-bold">{entry.description}</h1>
          <p className="text-sm text-muted">
            {entry.date.toISOString().slice(0, 10)} ·{" "}
            <span className="badge bg-primary/10 text-primary">{SOURCE_TYPE_LABELS[entry.sourceType as SourceType] || entry.sourceType}</span>
            {entry.property && <> · {entry.property.name}</>}
            {entry.lease && <> · {entry.lease.tenant.name}</>}
          </p>
        </div>
        <ConfirmButton action={deleteEntryAction} id={entry.id} label="Delete entry" className="btn-danger no-print" message="Delete this entry, its lines and files?" />
      </div>

      {sp.error && <div className="card p-3 bg-expense/5 border-expense/30 text-expense text-sm">{sp.error}</div>}

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[420px]">
          <thead>
            <tr>
              <th className="th">Account</th>
              <th className="th text-right">Debit</th>
              <th className="th text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l) => (
              <tr key={l.id}>
                <td className="td">
                  {l.account.code} {l.account.name}
                  {l.reconciledAt && <span className="badge bg-income/10 text-income ml-2">reconciled</span>}
                </td>
                <td className="td text-right num">{Number(l.debit) > 0 ? Number(l.debit).toFixed(2) : ""}</td>
                <td className="td text-right num">{Number(l.credit) > 0 ? Number(l.credit).toFixed(2) : ""}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold border-t-2 border-ink">
              <td className="td text-right">Total</td>
              <td className="td text-right num">{totalDebit.toFixed(2)}</td>
              <td className="td text-right num">{totalDebit.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Receipts */}
      <div className="card p-4">
        <h2 className="font-semibold mb-3">Receipts &amp; attachments</h2>
        {atts.length === 0 ? (
          <p className="text-sm text-muted mb-3">No attachments.</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
            {atts.map((a) => (
              <div key={a.id} className="border border-line rounded-md p-2">
                {a.mimeType.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <a href={a.url} target="_blank" rel="noreferrer">
                    <img src={a.url} alt={a.fileName} className="w-full h-28 object-cover rounded" />
                  </a>
                ) : (
                  <a href={a.url} target="_blank" rel="noreferrer" className="flex items-center justify-center h-28 bg-canvas rounded text-4xl">
                    📄
                  </a>
                )}
                <div className="mt-1 flex items-center justify-between gap-1">
                  <a href={a.url} target="_blank" rel="noreferrer" className="text-xs text-primary truncate">
                    {a.fileName}
                  </a>
                  <ConfirmButton action={deleteAttachmentAction} id={a.id} fields={{ entryId: entry.id }} label="✕" message="Delete this attachment?" className="text-expense text-xs no-print" />
                </div>
              </div>
            ))}
          </div>
        )}
        <form action={`/api/entries/${entry.id}/attachments`} method="post" encType="multipart/form-data" className="flex flex-wrap gap-2 items-center no-print">
          <input type="file" name="attachments" accept="image/*,application/pdf" multiple required className="text-sm" />
          <button className="btn-primary">Upload</button>
        </form>
      </div>
    </div>
  );
}
