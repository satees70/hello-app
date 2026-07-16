"use client";

import Papa from "papaparse";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CsvMapping, detectCsvMapping, parseCsvStatement } from "@/lib/reconcile/csv";

interface SavedMapping {
  bankName: string;
  mapping: CsvMapping;
}

type AmountMode = "single" | "split";

export default function CsvImport({ savedMappings }: { savedMappings: SavedMapping[] }) {
  const router = useRouter();
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [bankName, setBankName] = useState("");
  const [saveMapping, setSaveMapping] = useState(true);
  const [amountMode, setAmountMode] = useState<AmountMode>("single");
  const [map, setMap] = useState<CsvMapping>({ date: "", description: "", amount: "", debit: "", credit: "", balance: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function applyMapping(m: Partial<CsvMapping>) {
    setMap((prev) => ({ ...prev, ...m }));
    if (m.debit || m.credit) setAmountMode("split");
    else if (m.amount) setAmountMode("single");
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError("");
    setFileName(file.name);
    const text = await file.text();
    setCsvText(text);
    const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true, preview: 3, transformHeader: (h) => h.trim() });
    const hs = res.meta.fields ?? [];
    setHeaders(hs);
    const detected = detectCsvMapping(hs);
    applyMapping({ date: detected.date ?? "", description: detected.description ?? "", amount: detected.amount ?? "", debit: detected.debit ?? "", credit: detected.credit ?? "", balance: detected.balance ?? "" });
  }

  function onBankChange(name: string) {
    setBankName(name);
    const saved = savedMappings.find((s) => s.bankName.toLowerCase() === name.toLowerCase());
    if (saved && headers.length) applyMapping(saved.mapping);
  }

  const effectiveMapping: CsvMapping = useMemo(() => {
    if (amountMode === "single") return { date: map.date, description: map.description, amount: map.amount, balance: map.balance };
    return { date: map.date, description: map.description, debit: map.debit, credit: map.credit, balance: map.balance };
  }, [map, amountMode]);

  const preview = useMemo(() => {
    if (!csvText || !map.date || !map.description) return null;
    if (amountMode === "single" && !map.amount) return null;
    if (amountMode === "split" && !map.debit && !map.credit) return null;
    try {
      return parseCsvStatement(csvText, effectiveMapping);
    } catch {
      return null;
    }
  }, [csvText, map, amountMode, effectiveMapping]);

  async function submit() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/reconciliation/import-csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csvText, fileName, bankName: bankName || undefined, saveMapping, mapping: effectiveMapping }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Import failed.");
      return;
    }
    const { id } = await res.json();
    router.push(`/reconciliation/${id}`);
  }

  const Sel = ({ field, label, optional }: { field: keyof CsvMapping; label: string; optional?: boolean }) => (
    <div>
      <label className="label">
        {label} {optional && <span className="text-muted">(optional)</span>}
      </label>
      <select className="input" value={(map[field] as string) || ""} onChange={(e) => setMap({ ...map, [field]: e.target.value })}>
        <option value="">—</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <label className="label">CSV file</label>
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="text-sm" />
      </div>

      {headers.length > 0 && (
        <>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Bank (saves this mapping for next time)</label>
              <input className="input" list="saved-banks" value={bankName} onChange={(e) => onBankChange(e.target.value)} placeholder="e.g. Maybank" />
              <datalist id="saved-banks">
                {savedMappings.map((s) => (
                  <option key={s.bankName} value={s.bankName} />
                ))}
              </datalist>
            </div>
            <label className="flex items-center gap-2 text-sm mt-6">
              <input type="checkbox" checked={saveMapping} onChange={(e) => setSaveMapping(e.target.checked)} /> Remember this column mapping for this bank
            </label>
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <Sel field="date" label="Date column" />
            <Sel field="description" label="Description column" />
            <div>
              <label className="label">Amount format</label>
              <select className="input" value={amountMode} onChange={(e) => setAmountMode(e.target.value as AmountMode)}>
                <option value="single">Single signed amount</option>
                <option value="split">Separate debit &amp; credit</option>
              </select>
            </div>
            {amountMode === "single" ? (
              <Sel field="amount" label="Amount column" />
            ) : (
              <>
                <Sel field="debit" label="Debit (money out)" />
                <Sel field="credit" label="Credit (money in)" />
              </>
            )}
            <Sel field="balance" label="Running balance" optional />
          </div>

          {preview && (
            <div className="card overflow-x-auto">
              <div className="px-3 py-2 text-xs text-muted border-b border-line">
                Preview — {preview.lines.length} line(s). Opening {preview.openingBalance ?? "?"} · Closing {preview.closingBalance ?? "?"}
              </div>
              <table className="w-full min-w-[420px]">
                <thead>
                  <tr>
                    <th className="th">Date</th>
                    <th className="th">Description</th>
                    <th className="th text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.slice(0, 6).map((l, i) => (
                    <tr key={i}>
                      <td className="td">{l.date}</td>
                      <td className="td">{l.description}</td>
                      <td className={`td text-right num ${Number(l.amount) < 0 ? "text-expense" : "text-income"}`}>{l.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {error && <p className="text-sm text-expense">{error}</p>}
          <button className="btn-primary" disabled={!preview || busy} onClick={submit}>
            {busy ? "Importing…" : "Import & start reconciling"}
          </button>
        </>
      )}
    </div>
  );
}
