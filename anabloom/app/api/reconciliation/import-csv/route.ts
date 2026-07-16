import { NextResponse } from "next/server";
import { z } from "zod";
import { currentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CsvMapping, parseCsvStatement } from "@/lib/reconcile/csv";
import { createStatement } from "@/lib/services/reconciliation";

const schema = z.object({
  csvText: z.string().min(1),
  fileName: z.string().default("statement.csv"),
  bankName: z.string().optional(),
  saveMapping: z.boolean().optional(),
  mapping: z.object({
    date: z.string(),
    description: z.string(),
    amount: z.string().optional(),
    debit: z.string().optional(),
    credit: z.string().optional(),
    balance: z.string().optional(),
  }),
});

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { csvText, fileName, bankName, saveMapping, mapping } = parsed.data;

  if (!mapping.amount && !(mapping.debit || mapping.credit)) {
    return NextResponse.json({ error: "Map either an amount column or debit/credit columns." }, { status: 400 });
  }

  const statement = parseCsvStatement(csvText, mapping as CsvMapping);
  if (statement.lines.length === 0) {
    return NextResponse.json({ error: "No transactions parsed with this mapping." }, { status: 400 });
  }
  if (bankName) statement.bankName = bankName;

  if (saveMapping && bankName) {
    await prisma.savedCsvMapping.upsert({
      where: { userId_bankName: { userId, bankName } },
      update: { mappingJson: JSON.stringify(mapping) },
      create: { userId, bankName, mappingJson: JSON.stringify(mapping) },
    });
  }

  const created = await createStatement(userId, fileName, statement);
  return NextResponse.json({ id: created.id });
}
