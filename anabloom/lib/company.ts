import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUserId } from "./auth";
import { prisma } from "./prisma";
import { getUser } from "./session";

export const ACTIVE_COMPANY_COOKIE = "anabloom_active_company";

/**
 * Resolve the active company for a page render. Redirects to /login if not
 * authenticated and to /onboarding if the user has no company yet. Every page
 * MUST go through this (never query business data by userId directly).
 */
export async function getActiveCompany() {
  const user = await getUser();
  const companies = await prisma.company.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  if (companies.length === 0) redirect("/onboarding");

  const cid = cookies().get(ACTIVE_COMPANY_COOKIE)?.value;
  const company = companies.find((c) => c.id === cid) ?? companies[0];
  return { user, company, companies };
}

/**
 * Resolve + authorize the active company inside a server action / API route.
 * Verifies the company belongs to the logged-in user. Throws (never redirects).
 */
export async function requireCompany(): Promise<{ userId: string; companyId: string; currency: string }> {
  const userId = await requireUserId();
  const cid = cookies().get(ACTIVE_COMPANY_COOKIE)?.value;
  let company = cid ? await prisma.company.findFirst({ where: { id: cid, userId } }) : null;
  if (!company) company = await prisma.company.findFirst({ where: { userId }, orderBy: { createdAt: "asc" } });
  if (!company) throw new Error("No company found. Create a company first.");
  return { userId, companyId: company.id, currency: company.currency };
}

/** Verify a company id belongs to the user, or throw. Use before scoped writes. */
export async function assertCompanyOwnership(userId: string, companyId: string): Promise<void> {
  const c = await prisma.company.findFirst({ where: { id: companyId, userId }, select: { id: true } });
  if (!c) throw new Error("Company not found or not yours.");
}
