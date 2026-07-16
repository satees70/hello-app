import { NextResponse } from "next/server";
import { requireCompany } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { getStorage } from "@/lib/storage";
import { validateUpload } from "@/lib/upload";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { companyId } = await requireCompany().catch(() => ({ companyId: "" }));
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const lease = await prisma.lease.findFirst({ where: { id, companyId } });
  if (!lease) return NextResponse.json({ error: "Lease not found" }, { status: 404 });

  const fd = await req.formData();
  const file = fd.get("file") as File | null;
  const label = ((fd.get("label") as string) || "Document").trim();
  if (!file) return NextResponse.json({ error: "No file" }, { status: 400 });
  const err = validateUpload(file);
  if (err) return NextResponse.json({ error: err }, { status: 400 });

  const stored = await getStorage().put(companyId, file.name, file.type, Buffer.from(await file.arrayBuffer()));
  await prisma.leaseDocument.create({
    data: {
      companyId,
      leaseId: id,
      label,
      fileName: stored.fileName,
      storagePath: stored.storagePath,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
    },
  });
  return NextResponse.redirect(new URL(`/tenants/${id}`, req.url), 303);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { companyId } = await requireCompany().catch(() => ({ companyId: "" }));
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const docId = new URL(req.url).searchParams.get("docId");
  if (!docId) return NextResponse.json({ error: "docId required" }, { status: 400 });
  const doc = await prisma.leaseDocument.findFirst({ where: { id: docId, companyId, lease: { id } } });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await getStorage().remove(doc.storagePath);
  await prisma.leaseDocument.delete({ where: { id: docId } });
  return NextResponse.json({ ok: true });
}
