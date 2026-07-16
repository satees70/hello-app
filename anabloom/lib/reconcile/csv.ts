import Papa from "papaparse";
import { parseAmount, parseFlexibleDate } from "./dates";
import { ParsedLine, ParsedStatement } from "./types";

export interface CsvMapping {
  date: string;
  description: string;
  amount?: string; // single signed column
  debit?: string; // money out
  credit?: string; // money in
  balance?: string;
}

const DATE_HINTS = ["date", "txn date", "transaction date", "posting date", "tarikh"];
const DESC_HINTS = ["description", "desc", "details", "narration", "particulars", "transaction"];
const AMOUNT_HINTS = ["amount", "value", "jumlah"];
const DEBIT_HINTS = ["debit", "withdrawal", "dr", "out", "paid out"];
const CREDIT_HINTS = ["credit", "deposit", "cr", "in", "paid in"];
const BALANCE_HINTS = ["balance", "baki", "running balance"];

function findHeader(headers: string[], hints: string[]): string | undefined {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const hint of hints) {
    const i = lower.findIndex((h) => h === hint);
    if (i >= 0) return headers[i];
  }
  for (const hint of hints) {
    const i = lower.findIndex((h) => h.includes(hint));
    if (i >= 0) return headers[i];
  }
  return undefined;
}

/** Suggest a column mapping from CSV headers. */
export function detectCsvMapping(headers: string[]): Partial<CsvMapping> {
  const mapping: Partial<CsvMapping> = {};
  mapping.date = findHeader(headers, DATE_HINTS);
  mapping.description = findHeader(headers, DESC_HINTS);
  const debit = findHeader(headers, DEBIT_HINTS);
  const credit = findHeader(headers, CREDIT_HINTS);
  if (debit && credit) {
    mapping.debit = debit;
    mapping.credit = credit;
  } else {
    mapping.amount = findHeader(headers, AMOUNT_HINTS);
  }
  mapping.balance = findHeader(headers, BALANCE_HINTS);
  return mapping;
}

export function parseCsvStatement(text: string, mapping?: CsvMapping): ParsedStatement {
  const warnings: string[] = [];
  const parsed = Papa.parse<Record<string, string>>(text.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const headers = parsed.meta.fields ?? [];
  const map = { ...detectCsvMapping(headers), ...(mapping ?? {}) } as CsvMapping;

  if (!map.date || !map.description) warnings.push("Could not auto-detect date/description columns.");
  if (!map.amount && !(map.debit && map.credit))
    warnings.push("Could not auto-detect amount (or debit+credit) columns.");

  const lines: ParsedLine[] = [];
  let year: number | undefined;
  for (const row of parsed.data) {
    const rawDate = map.date ? row[map.date] : "";
    const iso = rawDate ? parseFlexibleDate(rawDate, year) : null;
    if (!iso) continue;
    year = +iso.slice(0, 4);

    let amount: number | null = null;
    if (map.amount) {
      amount = parseAmount(row[map.amount] ?? "");
    } else if (map.debit || map.credit) {
      const d = map.debit ? parseAmount(row[map.debit] ?? "") : 0;
      const c = map.credit ? parseAmount(row[map.credit] ?? "") : 0;
      amount = (c ?? 0) - Math.abs(d ?? 0);
    }
    if (amount === null || Number.isNaN(amount)) continue;

    const line: ParsedLine = {
      date: iso,
      description: (map.description ? row[map.description] : "")?.trim() || "(no description)",
      amount: amount.toFixed(2),
    };
    if (map.balance && row[map.balance]) {
      const b = parseAmount(row[map.balance]);
      if (b !== null) line.runningBalance = b.toFixed(2);
    }
    lines.push(line);
  }

  const openingBalance = lines.length && lines[0].runningBalance
    ? (parseFloat(lines[0].runningBalance) - parseFloat(lines[0].amount)).toFixed(2)
    : undefined;
  const closingBalance = lines.length ? lines[lines.length - 1].runningBalance : undefined;

  return {
    lines,
    profile: "csv",
    warnings,
    periodStart: lines[0]?.date,
    periodEnd: lines[lines.length - 1]?.date,
    openingBalance,
    closingBalance,
  };
}
