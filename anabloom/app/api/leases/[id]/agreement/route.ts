import { NextResponse } from "next/server";
import { requireCompany } from "@/lib/company";
import { prisma } from "@/lib/prisma";
import { buildTenancyAgreementDocx } from "@/lib/services/tenancyAgreement";

export const dynamic = "force-dynamic";

// GET /api/leases/:id/agreement → downloads a filled .docx tenancy agreement.
// Scoped to the active company (same access rule as viewing the lease).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { companyId } = await requireCompany().catch(() => ({ companyId: "" }));
  if (!companyId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const lease = await prisma.lease.findFirst({
    where: { id, companyId },
    include: { tenant: true, property: true },
  });
  if (!lease) return NextResponse.json({ error: "Lease not found" }, { status: 404 });

  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const buf = await buildTenancyAgreementDocx({
    company,
    property: lease.property,
    tenant: lease.tenant,
    lease,
  });

  const safe = (lease.tenant.name || "tenant").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="Tenancy_Agreement_${safe || "tenant"}.docx"`,
      "Cache-Control": "no-store",
    },
  });
}
