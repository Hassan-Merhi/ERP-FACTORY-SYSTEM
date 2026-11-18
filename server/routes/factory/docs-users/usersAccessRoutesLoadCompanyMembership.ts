// Extracted from ./usersAccessRoutes.ts to keep that module under the source-size cap.
import { db } from "../../../db";
import { userCompanyRoles } from "@shared/schema";
import { and, eq } from "drizzle-orm";

export function requesterIsDeveloper(currentRole: unknown, requestRole: unknown): boolean {
  return currentRole === "Developer" || requestRole === "Developer";
}

export function canManageFactoryUsers(currentRole: unknown, requestRole: unknown): boolean {
  return (
    ["Admin", "Owner", "Developer"].includes(String(currentRole ?? "")) ||
    ["Admin", "Developer"].includes(String(requestRole ?? ""))
  );
}

export async function loadCompanyMembership(userId: string, companyId: number) {
  const [membership] = await db
    .select({ role: userCompanyRoles.role })
    .from(userCompanyRoles)
    .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, companyId)))
    .limit(1);
  return membership ?? null;
}
