import { and, eq, inArray, or } from "drizzle-orm";
import { companies, userCompanyRoles } from "@shared/schema";
import { db } from "../../db";

export const globalCompanyTypeFilter = or(
  eq(companies.companyType, "erp"),
  eq(companies.companyType, "properties"),
  eq(companies.companyType, "factory"),
  eq(companies.companyType, "factory_v2"),
  eq(companies.companyType, "supplier_partner"),
  eq(companies.companyType, "retail")
);

export async function resolveAllowedGlobalCompanyIds(
  userId: string,
  role: string
): Promise<number[]> {
  if (role === "Developer") {
    const rows = await db
      .select({ id: companies.id })
      .from(companies)
      .where(globalCompanyTypeFilter);
    return rows.map((row) => row.id);
  }

  const assignedRows = await db
    .select({ companyId: userCompanyRoles.companyId })
    .from(userCompanyRoles)
    .where(eq(userCompanyRoles.userId, userId));
  const assignedIds = [...new Set(assignedRows.map((row) => row.companyId))];
  if (assignedIds.length === 0) return [];

  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(globalCompanyTypeFilter, inArray(companies.id, assignedIds)));
  return rows.map((row) => row.id);
}

export async function userCanAccessGlobalCompany(
  userId: string,
  role: string,
  companyId: number
): Promise<boolean> {
  const allowed = await resolveAllowedGlobalCompanyIds(userId, role);
  return allowed.includes(companyId);
}
