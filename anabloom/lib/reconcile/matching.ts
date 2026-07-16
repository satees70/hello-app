import Decimal from "decimal.js";
import { MatchStatus } from "../enums";
import { money, round2 } from "../money";

export interface StmtLineInput {
  id: string;
  date: Date;
  description: string;
  amount: Decimal.Value; // signed: + money in, - money out
}

export interface CashLineInput {
  id: string; // journal line id
  date: Date;
  description: string;
  amount: Decimal.Value; // signed cash movement: debit(+) - credit(-)
}

export interface MatchSuggestion {
  journalLineId: string;
  confidence: number; // 0..1
}

export interface MatchResult {
  statementLineId: string;
  matchStatus: MatchStatus; // AUTO_MATCHED only when high-confidence & unique
  matchedJournalLineId?: string;
  matchConfidence?: number;
  suggestions: MatchSuggestion[]; // ranked; present when confirmation needed
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayDiff(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / DAY_MS));
}

function trigrams(s: string): Set<string> {
  const t = ` ${s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim()} `;
  const g = new Set<string>();
  for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
  return g;
}

/** Dice coefficient over character trigrams: 0..1 */
export function descriptionSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// High-confidence threshold: only unique matches at/above this auto-match.
export const HIGH_CONFIDENCE = 0.9;

/**
 * Deterministic auto-matching against unreconciled cash journal lines.
 *
 * Tiers:
 *  - 1.0  : exact amount + same date, unique candidate           -> AUTO_MATCHED
 *  - >=0.9: exact amount + date within +/-3 days, unique         -> AUTO_MATCHED
 *  - <0.9 : exact amount, multiple candidates OR weak proximity  -> needs user
 *           confirmation (ranked suggestions, never auto-confirmed)
 *
 * Greedy + deterministic: a journal line is never assigned to two statement
 * lines. Statement lines are processed in their given order.
 */
export function matchStatement(
  statementLines: StmtLineInput[],
  cashLines: CashLineInput[]
): MatchResult[] {
  const used = new Set<string>();
  const results: MatchResult[] = [];

  // Pre-index candidates by exact signed amount.
  const norm = (v: Decimal.Value) => round2(money(v)).toFixed(2);
  const byAmount = new Map<string, CashLineInput[]>();
  for (const c of cashLines) {
    const k = norm(c.amount);
    const arr = byAmount.get(k) ?? [];
    arr.push(c);
    byAmount.set(k, arr);
  }

  for (const s of statementLines) {
    const exact = (byAmount.get(norm(s.amount)) ?? []).filter((c) => !used.has(c.id));

    if (exact.length === 0) {
      results.push({ statementLineId: s.id, matchStatus: "UNMATCHED", suggestions: [] });
      continue;
    }

    // Score every exact-amount candidate.
    const scored = exact
      .map((c) => {
        const dd = dayDiff(s.date, c.date);
        const sim = descriptionSimilarity(s.description, c.description);
        let confidence: number;
        if (dd === 0) confidence = 1.0;
        else if (dd <= 3) confidence = round2(new Decimal(1).minus(new Decimal(dd).times(0.03))).toNumber();
        else confidence = round2(new Decimal(0.6).minus(new Decimal(Math.min(dd, 30)).times(0.01))).toNumber();
        // blend a little description similarity into sub-high tiers
        if (confidence < HIGH_CONFIDENCE) confidence = round2(new Decimal(confidence).times(0.7).plus(new Decimal(sim).times(0.3))).toNumber();
        return { c, dd, sim, confidence };
      })
      .sort((a, b) => b.confidence - a.confidence || a.dd - b.dd || b.sim - a.sim);

    const best = scored[0];
    const unique = scored.length === 1;
    const suggestions: MatchSuggestion[] = scored.map((x) => ({
      journalLineId: x.c.id,
      confidence: x.confidence,
    }));

    if (unique && best.confidence >= HIGH_CONFIDENCE) {
      used.add(best.c.id);
      results.push({
        statementLineId: s.id,
        matchStatus: "AUTO_MATCHED",
        matchedJournalLineId: best.c.id,
        matchConfidence: best.confidence,
        suggestions,
      });
    } else {
      // Multiple candidates, or weak proximity: require user confirmation.
      results.push({
        statementLineId: s.id,
        matchStatus: "UNMATCHED",
        matchConfidence: best.confidence,
        suggestions,
      });
    }
  }

  return results;
}

// ---------- Continuity + finish-reconciliation checks ----------
export interface ContinuityCheck {
  expectedClosing: Decimal;
  actualClosing: Decimal;
  difference: Decimal; // 0 => continuous
  ok: boolean;
}

export function continuityCheck(
  opening: Decimal.Value,
  lines: { amount: Decimal.Value }[],
  closing: Decimal.Value
): ContinuityCheck {
  let sum = money(opening);
  for (const l of lines) sum = sum.plus(money(l.amount));
  const expected = round2(sum);
  const actual = round2(money(closing));
  const difference = round2(expected.minus(actual));
  return { expectedClosing: expected, actualClosing: actual, difference, ok: difference.abs().lessThanOrEqualTo(0.01) };
}

export const RESOLVED_STATUSES: MatchStatus[] = ["CONFIRMED", "ENTRY_CREATED", "IGNORED"];

export interface FinishCheck {
  allResolved: boolean;
  continuity: ContinuityCheck;
  canFinish: boolean;
}

export function canFinishReconciliation(
  opening: Decimal.Value,
  closing: Decimal.Value,
  lines: { amount: Decimal.Value; matchStatus: MatchStatus }[]
): FinishCheck {
  const allResolved = lines.every((l) => RESOLVED_STATUSES.includes(l.matchStatus));
  const continuity = continuityCheck(opening, lines, closing);
  return { allResolved, continuity, canFinish: allResolved && continuity.ok };
}

export interface ReconciliationReport {
  opening: Decimal;
  closing: Decimal;
  clearedIn: Decimal;
  clearedOut: Decimal;
  ignoredCount: number;
  outstanding: { id: string; date: string; description: string; amount: string }[];
  difference: Decimal;
}

export function buildReconciliationReport(
  opening: Decimal.Value,
  closing: Decimal.Value,
  lines: { amount: Decimal.Value; matchStatus: MatchStatus }[],
  outstandingBookLines: { id: string; date: Date; description: string; amount: Decimal.Value }[]
): ReconciliationReport {
  let clearedIn = new Decimal(0);
  let clearedOut = new Decimal(0);
  let ignoredCount = 0;
  for (const l of lines) {
    if (l.matchStatus === "IGNORED") {
      ignoredCount++;
      continue;
    }
    const a = money(l.amount);
    if (a.greaterThan(0)) clearedIn = clearedIn.plus(a);
    else clearedOut = clearedOut.plus(a.abs());
  }
  const continuity = continuityCheck(opening, lines, closing);
  return {
    opening: round2(money(opening)),
    closing: round2(money(closing)),
    clearedIn: round2(clearedIn),
    clearedOut: round2(clearedOut),
    ignoredCount,
    outstanding: outstandingBookLines.map((l) => ({
      id: l.id,
      date: l.date.toISOString().slice(0, 10),
      description: l.description,
      amount: round2(money(l.amount)).toFixed(2),
    })),
    difference: continuity.difference,
  };
}
