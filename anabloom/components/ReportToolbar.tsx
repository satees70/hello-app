"use client";

export default function ReportToolbar({ rows, filename }: { rows: string[][]; filename: string }) {
  function exportCsv() {
    const csv = rows
      .map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="flex gap-2 no-print">
      <button onClick={() => window.print()} className="btn-ghost">
        Print
      </button>
      <button onClick={exportCsv} className="btn-ghost">
        Export CSV
      </button>
    </div>
  );
}
