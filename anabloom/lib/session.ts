import { redirect } from "next/navigation";
import { currentUserId } from "./auth";
import { prisma } from "./prisma";

export async function getUser() {
  const id = await currentUserId();
  if (!id) redirect("/login");
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) redirect("/login");
  return user;
}
