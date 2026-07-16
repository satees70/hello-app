import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { catchUpInvoices } from "@/lib/services/recurring";

// Vercel Cron hits this monthly. Also runs idempotently on dashboard load.
// Protected by CRON_SECRET (Vercel sends "Authorization: Bearer <CRON_SECRET>").
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  const users = await prisma.user.findMany({ select: { id: true } });
  let total = 0;
  for (const u of users) total += await catchUpInvoices(u.id);
  return NextResponse.json({ ok: true, invoicesCreated: total, users: users.length });
}
