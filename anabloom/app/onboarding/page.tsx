import { redirect } from "next/navigation";
import { createCompanyAction } from "@/app/actions";
import { prisma } from "@/lib/prisma";
import { getUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await getUser();
  const count = await prisma.company.count({ where: { userId: user.id } });
  if (count > 0) redirect("/");

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-3xl font-bold text-primary">Anabloom</h1>
          <p className="text-sm text-muted mt-1">Let’s create your first company</p>
        </div>
        <form action={createCompanyAction} className="card p-6 space-y-4">
          <p className="text-sm text-muted">
            Anabloom keeps a fully separate set of books per company. You can add more later in Settings and switch between
            them anytime.
          </p>
          <div>
            <label className="label">Company name</label>
            <input className="input" name="name" placeholder="e.g. Acme Properties Sdn Bhd" required autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Registration no. (optional)</label>
              <input className="input" name="registrationNo" />
            </div>
            <div>
              <label className="label">Currency</label>
              <input className="input" name="currency" defaultValue="RM" maxLength={5} />
            </div>
          </div>
          <button className="btn-primary w-full">Create company</button>
        </form>
      </div>
    </div>
  );
}
