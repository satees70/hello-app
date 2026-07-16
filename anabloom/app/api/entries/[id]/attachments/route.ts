import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { saveEntryAttachments } from "@/lib/services/attachments";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const fd = await req.formData();
  const files = fd.getAll("attachments").filter((f): f is File => f instanceof File && f.size > 0);
  try {
    await saveEntryAttachments(userId, id, files);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    return NextResponse.redirect(new URL(`/ledger/${id}?error=${encodeURIComponent(msg)}`, req.url), 303);
  }
  return NextResponse.redirect(new URL(`/ledger/${id}`, req.url), 303);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const attId = new URL(req.url).searchParams.get("attachmentId");
  if (!attId) return NextResponse.json({ error: "attachmentId required" }, { status: 400 });
  const att = await prisma.attachment.findFirst({ where: { id: attId, entry: { id, userId } } });
  if (!att) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await getStorage().remove(att.storagePath);
  await prisma.attachment.delete({ where: { id: attId } });
  return NextResponse.json({ ok: true });
}
