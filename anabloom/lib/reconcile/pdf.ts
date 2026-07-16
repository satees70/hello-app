import { parseAmount, parseFlexibleDate } from "./dates";
import { ParsedLine, ParsedStatement } from "./types";

const DATE_RE = /^(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[\s-][A-Za-z]{3,}(?:[\s-]\d{2,4})?)/;
const AMOUNT_TOKEN = /[-(]?\d[\d,]*\.\d{2}\)?(?:\s?(?:DR|CR|\+|-))?/gi;

interface Profile {
  name: string;
  bankName: string;
  detect: (text: string) => boolean;
}

const PROFILES: Profile[] = [
  { name: "maybank", bankName: "Maybank", detect: (t) => /maybank|malayan banking/i.test(t) },
  { name: "cimb", bankName: "CIMB Bank", detect: (t) => /cimb/i.test(t) },
  { name: "public-bank", bankName: "Public Bank", detect: (t) => /public bank/i.test(t) },
  { name: "rhb", bankName: "RHB Bank", detect: (t) => /rhb/i.test(t) },
];

function detectProfile(text: string): Profile | null {
  return PROFILES.find((p) => p.detect(text)) ?? null;
}

function findBalanceLabel(text: string, labels: RegExp): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (labels.test(line)) {
      const amounts = line.match(AMOUNT_TOKEN);
      if (amounts && amounts.length) {
        const v = parseAmount(amounts[amounts.length - 1]);
        if (v !== null) return v.toFixed(2);
      }
    }
  }
  return undefined;
}

/**
 * Parse the *text* of a (text-based) bank statement PDF into structured lines.
 * Uses layout heuristics: a leading date, a description, a trailing transaction
 * amount and an optional running-balance column. Sign is taken from explicit
 * DR/CR markers, else inferred from the running-balance delta.
 */
export function parseStatementText(text: string, forceProfile?: string): ParsedStatement {
  const warnings: string[] = [];
  const profile = forceProfile
    ? PROFILES.find((p) => p.name === forceProfile) ?? null
    : detectProfile(text);

  const rawLines = text.split(/\r?\n/);
  const lines: ParsedLine[] = [];
  let year: number | undefined;
  // Seed the running balance from a detected opening balance so the first
  // transaction's direction can be inferred from the balance delta too.
  const openingLabel = findBalanceLabel(text, /beginning balance|opening balance|balance b\/f|baki awal/i);
  let prevBalance: number | undefined = openingLabel ? parseFloat(openingLabel) : undefined;

  for (const raw of rawLines) {
    const line = raw.trim();
    const dm = line.match(DATE_RE);
    if (!dm) continue;
    const iso = parseFlexibleDate(dm[1].trim(), year);
    if (!iso) continue;

    const rest = line.slice(dm[0].length).trim();
    const amountMatches = rest.match(AMOUNT_TOKEN);
    if (!amountMatches || amountMatches.length === 0) continue;

    year = +iso.slice(0, 4);

    // Description = text before the first amount token.
    const firstAmtIdx = rest.search(AMOUNT_TOKEN);
    const description = rest.slice(0, firstAmtIdx).trim() || "(no description)";

    let balance: number | undefined;
    let amount: number | null;
    if (amountMatches.length >= 2) {
      balance = parseAmount(amountMatches[amountMatches.length - 1]) ?? undefined;
      amount = parseAmount(amountMatches[amountMatches.length - 2]);
    } else {
      amount = parseAmount(amountMatches[0]);
    }
    if (amount === null) continue;

    // Sign inference: if no explicit DR/CR and a running balance is available,
    // use the balance delta to decide direction.
    const hadExplicitSign = /(DR|CR|\+|-|\()/i.test(amountMatches[amountMatches.length - (amountMatches.length >= 2 ? 2 : 1)]);
    if (!hadExplicitSign && balance !== undefined && prevBalance !== undefined) {
      amount = balance >= prevBalance ? Math.abs(amount) : -Math.abs(amount);
    }
    if (balance !== undefined) prevBalance = balance;

    const pl: ParsedLine = { date: iso, description, amount: amount.toFixed(2) };
    if (balance !== undefined) pl.runningBalance = balance.toFixed(2);
    lines.push(pl);
  }

  if (lines.length === 0) warnings.push("No transaction rows detected in the PDF text.");

  const opening =
    openingLabel ??
    (lines[0]?.runningBalance
      ? (parseFloat(lines[0].runningBalance) - parseFloat(lines[0].amount)).toFixed(2)
      : undefined);
  const closing =
    findBalanceLabel(text, /ending balance|closing balance|balance c\/f|baki akhir/i) ??
    lines[lines.length - 1]?.runningBalance;

  return {
    bankName: profile?.bankName,
    profile: profile?.name ?? "generic",
    lines,
    warnings,
    periodStart: lines[0]?.date,
    periodEnd: lines[lines.length - 1]?.date,
    openingBalance: opening,
    closingBalance: closing,
  };
}

/** Extract text from a PDF buffer. Detects image-only (scanned) PDFs. */
export async function extractPdfText(data: Uint8Array): Promise<{ text: string; imageOnly: boolean }> {
  // Dynamic import keeps pdfjs out of the unit-test path and the edge bundle.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Group text items into visual lines by their y position.
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items as { str: string; transform: number[] }[]) {
      if (!("str" in item)) continue;
      const y = Math.round(item.transform[5]);
      const x = item.transform[4];
      const arr = rows.get(y) ?? [];
      arr.push({ x, s: item.str });
      rows.set(y, arr);
    }
    const ys = [...rows.keys()].sort((a, b) => b - a);
    for (const y of ys) {
      const cells = rows.get(y)!.sort((a, b) => a.x - b.x);
      text += cells.map((c) => c.s).join(" ").replace(/\s+/g, " ").trim() + "\n";
    }
  }
  const imageOnly = text.replace(/\s/g, "").length < 20;
  return { text, imageOnly };
}
