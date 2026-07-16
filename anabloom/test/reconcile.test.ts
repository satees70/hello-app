import { describe, expect, it } from "vitest";
import {
  buildReconciliationReport,
  canFinishReconciliation,
  continuityCheck,
  matchStatement,
  StmtLineInput,
  CashLineInput,
} from "@/lib/reconcile/matching";

const D = (s: string) => new Date(s + "T00:00:00Z");

describe("auto-matching engine", () => {
  it("auto-matches exact amount + same date when unique (confidence 1.0)", () => {
    const stmt: StmtLineInput[] = [{ id: "s1", date: D("2026-02-01"), description: "RENTAL ALICE", amount: 1500 }];
    const cash: CashLineInput[] = [{ id: "c1", date: D("2026-02-01"), description: "Rent received Alice", amount: 1500 }];
    const res = matchStatement(stmt, cash);
    expect(res[0].matchStatus).toBe("AUTO_MATCHED");
    expect(res[0].matchedJournalLineId).toBe("c1");
    expect(res[0].matchConfidence).toBe(1);
  });

  it("auto-matches exact amount within +/-3 days when unique (high confidence)", () => {
    const stmt: StmtLineInput[] = [{ id: "s1", date: D("2026-02-04"), description: "TNB UTILITIES", amount: -320.5 }];
    const cash: CashLineInput[] = [{ id: "c1", date: D("2026-02-01"), description: "Utilities TNB", amount: -320.5 }];
    const res = matchStatement(stmt, cash);
    expect(res[0].matchStatus).toBe("AUTO_MATCHED");
    expect(res[0].matchConfidence).toBeGreaterThanOrEqual(0.9);
  });

  it("does NOT auto-confirm when two identical amounts collide near the same date", () => {
    // Two book entries of the same amount close in time — the matcher must ask.
    const stmt: StmtLineInput[] = [{ id: "s1", date: D("2026-02-02"), description: "RENT", amount: 1500 }];
    const cash: CashLineInput[] = [
      { id: "c1", date: D("2026-02-01"), description: "Rent unit A", amount: 1500 },
      { id: "c2", date: D("2026-02-03"), description: "Rent unit B", amount: 1500 },
    ];
    const res = matchStatement(stmt, cash);
    expect(res[0].matchStatus).toBe("UNMATCHED"); // requires user confirmation
    expect(res[0].matchedJournalLineId).toBeUndefined();
    expect(res[0].suggestions.length).toBe(2);
  });

  it("reports no suggestions when nothing matches the amount", () => {
    const stmt: StmtLineInput[] = [{ id: "s1", date: D("2026-02-02"), description: "X", amount: 999 }];
    const cash: CashLineInput[] = [{ id: "c1", date: D("2026-02-02"), description: "Y", amount: 111 }];
    const res = matchStatement(stmt, cash);
    expect(res[0].matchStatus).toBe("UNMATCHED");
    expect(res[0].suggestions.length).toBe(0);
  });

  it("never assigns one journal line to two statement lines", () => {
    const stmt: StmtLineInput[] = [
      { id: "s1", date: D("2026-02-01"), description: "A", amount: 500 },
      { id: "s2", date: D("2026-02-01"), description: "B", amount: 500 },
    ];
    const cash: CashLineInput[] = [{ id: "c1", date: D("2026-02-01"), description: "A", amount: 500 }];
    const res = matchStatement(stmt, cash);
    const assigned = res.filter((r) => r.matchedJournalLineId === "c1");
    expect(assigned.length).toBeLessThanOrEqual(1);
  });
});

describe("continuity + finish checks", () => {
  it("continuity holds when opening + lines == closing", () => {
    const c = continuityCheck(1000, [{ amount: 500 }, { amount: -200 }], 1300);
    expect(c.ok).toBe(true);
    expect(c.difference.toFixed(2)).toBe("0.00");
  });

  it("flags a continuity gap", () => {
    const c = continuityCheck(1000, [{ amount: 500 }], 1600);
    expect(c.ok).toBe(false);
    expect(c.difference.toFixed(2)).toBe("-100.00");
  });

  it("cannot finish while a line is unresolved", () => {
    const check = canFinishReconciliation(1000, 1300, [
      { amount: 500, matchStatus: "CONFIRMED" },
      { amount: -200, matchStatus: "UNMATCHED" },
    ]);
    expect(check.allResolved).toBe(false);
    expect(check.canFinish).toBe(false);
  });

  it("can finish when all resolved and continuity holds", () => {
    const check = canFinishReconciliation(1000, 1300, [
      { amount: 500, matchStatus: "CONFIRMED" },
      { amount: -200, matchStatus: "ENTRY_CREATED" },
    ]);
    expect(check.canFinish).toBe(true);
  });

  it("builds a reconciliation report with cleared totals and outstanding items", () => {
    const report = buildReconciliationReport(
      1000,
      1300,
      [
        { amount: 500, matchStatus: "CONFIRMED" },
        { amount: -200, matchStatus: "ENTRY_CREATED" },
      ],
      [{ id: "b1", date: D("2026-02-15"), description: "Uncleared cheque", amount: -50 }]
    );
    expect(report.clearedIn.toFixed(2)).toBe("500.00");
    expect(report.clearedOut.toFixed(2)).toBe("200.00");
    expect(report.outstanding.length).toBe(1);
    expect(report.difference.toFixed(2)).toBe("0.00");
  });
});
