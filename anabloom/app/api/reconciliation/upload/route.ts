import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { parseCsvStatement } from "@/lib/reconcile/csv";
import { extractPdfText, parseStatementText } from "@/lib/reconcile/pdf";
import { ParsedStatement } from "@/lib/reconcile/types";
import { createStatement } from "@/lib/services/reconciliation";

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const fd = await req.formData();
  const file = fd.get("file") as File | null;
  if (!file) return NextResponse.redirect(new URL("/reconciliation?error=No+file", req.url), 303);

  const name = file.name.toLowerCase();
  const bytes = Buffer.from(await file.arrayBuffer());
  let parsed: ParsedStatement;

  try {
    if (name.endsWith(".csv") || file.type === "text/csv") {
      parsed = parseCsvStatement(bytes.toString("utf8"));
    } else if (name.endsWith(".pdf") || file.type === "application/pdf") {
      const { text, imageOnly } = await extractPdfText(new Uint8Array(bytes));
      if (imageOnly) {
        return NextResponse.redirect(
          new URL("/reconciliation?error=" + encodeURIComponent("This looks like a scanned/image-only PDF. Please export a digital PDF or CSV statement."), req.url),
          303
        );
      }
      parsed = parseStatementText(text);
    } else {
      return NextResponse.redirect(new URL("/reconciliation?error=Unsupported+file+type", req.url), 303);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to parse statement";
    return NextResponse.redirect(new URL("/reconciliation?error=" + encodeURIComponent(msg), req.url), 303);
  }

  if (parsed.lines.length === 0) {
    return NextResponse.redirect(new URL("/reconciliation?error=" + encodeURIComponent("No transactions found in the file."), req.url), 303);
  }

  const statement = await createStatement(userId, file.name, parsed);
  return NextResponse.redirect(new URL(`/reconciliation/${statement.id}`, req.url), 303);
}
