import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { requireCompany } from "@/lib/company";
import { SOURCE_TYPE_LABELS, SourceType } from "@/lib/enums";
import { prisma } from "@/lib/prisma";

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export async function GET(req: Request) {
  const { companyId } = await requireCompany().catch(() => ({ companyId: "" }));
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);

  const where: Prisma.JournalEntryWhereInput = { companyId };
  const property = url.searchParams.get("property");
  const type = url.searchParams.get("type");
  const month = url.searchParams.get("month");
  if (property) where.propertyId = property;
  if (type) where.sourceType = type;
  if (month) {
    const [y, m] = month.split("-").map(Number);
    where.date = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
  }

  const entries = await prisma.journalEntry.findMany({
    where,
    include: { lines: { include: { account: true } }, property: true },
    orderBy: [{ date: "desc" }],
  });

  const rows = [["Date", "Property", "Description", "Type", "Account", "Debit", "Credit"]];
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push([
        e.date.toISOString().slice(0, 10),
        e.property?.name ?? "",
        e.description,
        SOURCE_TYPE_LABELS[e.sourceType as SourceType] ?? e.sourceType,
        `${l.account.code} ${l.account.name}`,
        Number(l.debit).toFixed(2),
        Number(l.credit).toFixed(2),
      ]);
    }
  }
  const csv = rows.map((r) => r.map((c) => csvCell(String(c))).join(",")).join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="anabloom-ledger.csv"`,
    },
  });
}
