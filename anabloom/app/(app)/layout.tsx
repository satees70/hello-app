import Nav from "@/components/Nav";
import { getActiveCompany } from "@/lib/company";
import { catchUpInvoices } from "@/lib/services/recurring";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, company, companies } = await getActiveCompany();
  // Idempotent catch-up so recurring rent invoices are never skipped.
  await catchUpInvoices(company.id).catch(() => {});

  return (
    <div className="min-h-screen">
      <Nav
        name={user.name || user.email}
        activeCompany={{ id: company.id, name: company.name }}
        companies={companies.map((c) => ({ id: c.id, name: c.name }))}
      />
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
