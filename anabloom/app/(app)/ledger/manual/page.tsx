import Link from "next/link";
import ManualEntryForm from "@/components/ManualEntryForm";
import { prisma } from "@/lib/prisma";
import { getUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ManualJournalPage() {
  const user = await getUser();
  const accounts = await prisma.account.findMany({
    where: { userId: user.id, active: true, code: { not: "3900" } }, // retained earnings not directly postable
    orderBy: { code: "asc" },
  });

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Manual journal entry</h1>
        <Link href="/ledger" className="btn-ghost">
          ← Ledger
        </Link>
      </div>
      <p className="text-sm text-muted">
        Pick any accounts and enter debit/credit lines. The entry must balance before it can be posted.
      </p>
      <ManualEntryForm accounts={accounts.map((a) => ({ code: a.code, name: a.name }))} />
    </div>
  );
}
