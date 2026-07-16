import { describe, expect, it } from "vitest";
import { apAging, ApBill, arAging, AgingInvoice, AgingPayment, tenantStatement } from "@/lib/reports";

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

describe("AP aging buckets (by days overdue)", () => {
  const S = (over: number, amount: number): ApBill => ({
    supplierId: "S",
    supplierName: "Sup",
    dueDate: daysAgo(over), // due `over` days ago
    amount,
    paid: 0,
  });

  it("buckets bills by days past the due date, with not-yet-due in 0–30", () => {
    const bills: ApBill[] = [
      { supplierId: "S", supplierName: "Sup", dueDate: new Date(asOf.getTime() + 10 * 86400000), amount: 100, paid: 0 }, // not due -> 0-30
      S(30, 200), // 0-30
      S(31, 300), // 31-60
      S(60, 400), // 31-60
      S(61, 500), // 61-90
      S(90, 600), // 61-90
      S(91, 700), // 90+
    ];
    const report = apAging(bills, asOf);
    const row = report.rows[0];
    expect(row.b0_30.toFixed(2)).toBe("300.00"); // 100 + 200
    expect(row.b31_60.toFixed(2)).toBe("700.00"); // 300 + 400
    expect(row.b61_90.toFixed(2)).toBe("1100.00"); // 500 + 600
    expect(row.b90plus.toFixed(2)).toBe("700.00");
    expect(row.total.toFixed(2)).toBe("2800.00");
  });

  it("nets out payments and excludes fully-paid bills", () => {
    const bills: ApBill[] = [
      { supplierId: "S", supplierName: "Sup", dueDate: daysAgo(10), amount: 1000, paid: 400 }, // 600 outstanding
      { supplierId: "S", supplierName: "Sup", dueDate: daysAgo(5), amount: 500, paid: 500 }, // paid -> excluded
    ];
    const report = apAging(bills, asOf);
    expect(report.totals.total.toFixed(2)).toBe("600.00");
  });

  it("supplier statement closing ties to the AP aging total", () => {
    const bills: ApBill[] = [
      { supplierId: "S", supplierName: "Sup", dueDate: daysAgo(40), amount: 1000, paid: 300 },
    ];
    const aging = apAging(bills, asOf);
    // statement: charge 1000, payment 300 => owed 700
    const st = tenantStatement(
      [
        { date: daysAgo(50), description: "Bill", debit: 1000, credit: 0 },
        { date: daysAgo(20), description: "Payment", debit: 0, credit: 300 },
      ],
      undefined,
      asOf
    );
    expect(st.closing.toFixed(2)).toBe(aging.totals.total.toFixed(2)); // 700.00
  });
});
