import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";

// Dev-mode file serving for the local storage driver. Paths are prefixed with
// the owning companyId; only that company's owner may read. Production uses
// Supabase signed URLs.
export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { path } = await params;
  const storagePath = path.join("/");
  const companyId = storagePath.split("/")[0];
  const owns = await prisma.company.findFirst({ where: { id: companyId, userId }, select: { id: true } });
  if (!owns) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const data = await getStorage().get(storagePath);
    return new NextResponse(new Uint8Array(data), {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, max-age=60" },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
