import Nav from "@/components/Nav";
import { getUser } from "@/lib/session";
import { catchUpInvoices } from "@/lib/services/recurring";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  // Idempotent catch-up so recurring rent invoices are never skipped.
  await catchUpInvoices(user.id).catch(() => {});

  return (
    <div className="min-h-screen">
      <Nav name={user.name || user.email} />
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
