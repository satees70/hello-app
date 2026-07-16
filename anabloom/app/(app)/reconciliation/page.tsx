import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getUser } from "@/lib/session";

export const dynamic = "force-dynamic";

const STATUS_CLS: Record<string, string> = {
  DRAFT: "bg-line text-muted",
  REVIEWED: "bg-amber-100 text-amber-700",
  RECONCILED: "bg-income/10 text-income",
};

export default async function ReconciliationIndex({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await getUser();
  const sp = await searchParams;
  const statements = await prisma.bankStatement.findMany({
    where: { userId: user.id },
    include: { _count: { select: { lines: true } } },
    orderBy: { uploadedAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Bank Reconciliation</h1>

      {sp.error && <div className="card p-3 bg-expense/5 border-expense/30 text-expense text-sm">{sp.error}</div>}

      <div className="card p-4">
        <h2 className="font-semibold mb-2">Upload a statement</h2>
        <p className="text-sm text-muted mb-3">
          Upload a bank statement as <strong>CSV</strong> or <strong>PDF</strong>. We parse it, auto-match against your book
          entries, and walk you through reconciling. Scanned/image-only PDFs aren’t supported — export a digital statement.
        </p>
        <form action="/api/reconciliation/upload" method="post" encType="multipart/form-data" className="flex flex-wrap gap-2 items-center">
          <input type="file" name="file" accept=".csv,.pdf,text/csv,application/pdf" required className="text-sm" />
          <button className="btn-primary">Upload &amp; parse</button>
        </form>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr>
              <th className="th">Uploaded</th>
              <th className="th">File</th>
              <th className="th">Bank</th>
              <th className="th">Period</th>
              <th className="th text-right">Lines</th>
              <th className="th">Status</th>
            </tr>
          </thead>
          <tbody>
            {statements.length === 0 && (
              <tr>
                <td className="td text-muted" colSpan={6}>
                  No statements uploaded yet.
                </td>
              </tr>
            )}
            {statements.map((st) => (
              <tr key={st.id}>
                <td className="td whitespace-nowrap">{st.uploadedAt.toISOString().slice(0, 10)}</td>
                <td className="td">
                  <Link href={`/reconciliation/${st.id}`} className="text-primary font-medium">
                    {st.fileName}
                  </Link>
                </td>
                <td className="td">{st.bankName || "—"}</td>
                <td className="td whitespace-nowrap text-xs">
                  {st.periodStart.toISOString().slice(0, 10)} → {st.periodEnd.toISOString().slice(0, 10)}
                </td>
                <td className="td text-right">{st._count.lines}</td>
                <td className="td">
                  <span className={`badge ${STATUS_CLS[st.status]}`}>{st.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
