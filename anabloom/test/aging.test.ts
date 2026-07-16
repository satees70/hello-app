import { describe, expect, it } from "vitest";
import { arAging, AgingInvoice, AgingPayment, tenantStatement } from "@/lib/reports";

const asOf = new Date(Date.UTC(2026, 3, 30)); // 30 Apr 2026
function daysAgo(n: number): Date {
  return new Date(asOf.getTime() - n * 24 * 60 * 60 * 1000);
}

describe("AR aging buckets", () => {
  it("places invoices in the correct bucket at boundaries", () => {
    const invoices: AgingInvoice[] = [
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(30), amount: 100 }, // 0-30
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(31), amount: 200 }, // 31-60
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(60), amount: 300 }, // 31-60
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(61), amount: 400 }, // 61-90
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(90), amount: 500 }, // 61-90
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(91), amount: 600 }, // 90+
    ];
    const report = arAging(invoices, [], asOf);
    const row = report.rows[0];
    expect(row.b0_30.toFixed(2)).toBe("100.00");
    expect(row.b31_60.toFixed(2)).toBe("500.00");
    expect(row.b61_90.toFixed(2)).toBe("900.00");
    expect(row.b90plus.toFixed(2)).toBe("600.00");
    expect(row.total.toFixed(2)).toBe("2100.00");
  });

  it("applies payments FIFO against the oldest invoices first", () => {
    const invoices: AgingInvoice[] = [
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(91), amount: 1000 }, // oldest -> 90+
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(10), amount: 1000 }, // newest -> 0-30
    ];
    const payments: AgingPayment[] = [{ leaseId: "L", amount: 1000 }];
    const report = arAging(invoices, payments, asOf);
    const row = report.rows[0];
    expect(row.b90plus.toFixed(2)).toBe("0.00"); // oldest fully paid
    expect(row.b0_30.toFixed(2)).toBe("1000.00");
    expect(row.total.toFixed(2)).toBe("1000.00");
  });

  it("tenant statement closing ties to the AR aging total for that tenant", () => {
    const invoices: AgingInvoice[] = [
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(60), amount: 1500 },
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(20), amount: 1500 },
    ];
    const payments: AgingPayment[] = [{ leaseId: "L", amount: 1000 }];
    const aging = arAging(invoices, payments, asOf);

    const st = tenantStatement(
      [
        { date: daysAgo(60), description: "Rent", debit: 1500, credit: 0 },
        { date: daysAgo(30), description: "Payment", debit: 0, credit: 1000 },
        { date: daysAgo(20), description: "Rent", debit: 1500, credit: 0 },
      ],
      undefined,
      asOf
    );
    expect(st.closing.toFixed(2)).toBe(aging.rows[0].total.toFixed(2)); // both = 2000.00
  });

  it("omits fully-paid leases", () => {
    const invoices: AgingInvoice[] = [
      { leaseId: "L", tenantName: "T", propertyName: "P", date: daysAgo(10), amount: 500 },
    ];
    const report = arAging(invoices, [{ leaseId: "L", amount: 500 }], asOf);
    expect(report.rows.length).toBe(0);
    expect(report.totals.total.toFixed(2)).toBe("0.00");
  });
});
