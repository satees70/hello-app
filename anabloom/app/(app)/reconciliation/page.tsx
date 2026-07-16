import Link from "next/link";
import CsvImport from "@/components/CsvImport";
import { CsvMapping } from "@/lib/reconcile/csv";
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
  const [statements, savedRaw] = await Promise.all([
    prisma.bankStatement.findMany({
      where: { userId: user.id },
      include: { _count: { select: { lines: true } } },
      orderBy: { uploadedAt: "desc" },
    }),
    prisma.savedCsvMapping.findMany({ where: { userId: user.id }, orderBy: { bankName: "asc" } }),
  ]);
  const savedMappings = savedRaw.map((s) => ({ bankName: s.bankName, mapping: JSON.parse(s.mappingJson) as CsvMapping }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Bank Reconciliation</h1>

      {sp.error && <div className="card p-3 bg-expense/5 border-expense/30 text-expense text-sm">{sp.error}</div>}

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card p-4">
          <h2 className="font-semibold mb-2">Import a CSV statement</h2>
          <p className="text-sm text-muted mb-3">
            Choose your file, map the columns (we pre-fill from the headers and any mapping saved for this bank), preview, then
            import.
          </p>
          <CsvImport savedMappings={savedMappings} />
        </div>

        <div className="card p-4">
          <h2 className="font-semibold mb-2">Upload a PDF statement</h2>
          <p className="text-sm text-muted mb-3">
            We extract the text and detect the transaction table (Maybank / CIMB / Public Bank / RHB profiles + a generic
            fallback). Scanned/image-only PDFs aren’t supported — export a digital statement or use CSV.
          </p>
          <form action="/api/reconciliation/upload" method="post" encType="multipart/form-data" className="flex flex-wrap gap-2 items-center">
            <input type="file" name="file" accept=".pdf,application/pdf" required className="text-sm" />
            <button className="btn-primary">Upload &amp; parse</button>
          </form>
        </div>
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
