import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { parseCsvStatement, detectCsvMapping } from "@/lib/reconcile/csv";
import { parseStatementText } from "@/lib/reconcile/pdf";

const fix = (f: string) => readFileSync(join(__dirname, "fixtures", f), "utf8");

describe("CSV statement parsing", () => {
  it("parses a Maybank debit/credit CSV into signed amounts", () => {
    const st = parseCsvStatement(fix("maybank-statement.csv"));
    expect(st.lines.length).toBe(5);
    expect(st.lines[0].amount).toBe("1500.00"); // credit => positive
    expect(st.lines[1].amount).toBe("-320.50"); // debit => negative
    expect(st.lines[0].date).toBe("2026-02-01");
  });

  it("parses a CIMB signed-amount CSV", () => {
    const st = parseCsvStatement(fix("cimb-statement.csv"));
    expect(st.lines.length).toBe(4);
    expect(st.lines[1].amount).toBe("-450.00");
    expect(st.lines[2].amount).toBe("150.00");
    expect(st.lines[0].runningBalance).toBe("11500.00");
  });

  it("auto-detects column mapping from headers", () => {
    const m = detectCsvMapping(["Date", "Description", "Debit", "Credit", "Balance"]);
    expect(m.date).toBe("Date");
    expect(m.debit).toBe("Debit");
    expect(m.credit).toBe("Credit");
    expect(m.balance).toBe("Balance");
  });

  it("respects an explicit column mapping with non-standard headers", () => {
    const csv = "Tarikh,Butiran,Wang Masuk,Wang Keluar\n01/02/2026,Sewa,1500.00,\n03/02/2026,Bil TNB,,320.50\n";
    const st = parseCsvStatement(csv, { date: "Tarikh", description: "Butiran", credit: "Wang Masuk", debit: "Wang Keluar" });
    expect(st.lines.length).toBe(2);
    expect(st.lines[0].amount).toBe("1500.00"); // credit => +
    expect(st.lines[1].amount).toBe("-320.50"); // debit => -
    expect(st.lines[0].description).toBe("Sewa");
  });
});

describe("PDF text statement parsing", () => {
  it("parses a Maybank-layout statement, inferring sign from running balance", () => {
    const st = parseStatementText(fix("maybank-text.txt"));
    expect(st.profile).toBe("maybank");
    expect(st.bankName).toBe("Maybank");
    expect(st.lines.length).toBe(5);
    expect(st.lines[0].amount).toBe("1500.00"); // credit (balance rose)
    expect(st.lines[1].amount).toBe("-320.50"); // debit (balance fell)
    expect(st.openingBalance).toBe("10000.00");
    expect(st.closingBalance).toBe("11899.50");
  });

  it("parses a CIMB-layout statement with dd MMM yyyy dates and explicit signs", () => {
    const st = parseStatementText(fix("cimb-text.txt"));
    expect(st.profile).toBe("cimb");
    expect(st.lines.length).toBe(4);
    expect(st.lines[0].date).toBe("2026-02-01");
    expect(st.lines[1].amount).toBe("-450.00");
    expect(st.lines[3].amount).toBe("-680.00");
    expect(st.closingBalance).toBe("10520.00");
  });
});
