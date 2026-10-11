import { eq, and, sql, asc } from "drizzle-orm";
import { db, type DatabaseOrTransaction } from "../db";
import * as schema from "@shared/schema";
import type { User, InsertUser, Company, InsertCompany, UserCompanyRole, InsertUserCompanyRole } from "@shared/schema";

// Users

export async function getUser(id: string): Promise<User | undefined> {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return user;
}

export async function getUserByUsername(username: string): Promise<User | undefined> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(sql`LOWER(${schema.users.username}) = LOWER(${username})`);
  return user;
}

export async function createUser(insertUser: InsertUser): Promise<User> {
  const [user] = await db.insert(schema.users).values(insertUser).returning();
  return user;
}

export async function getAllUsers(): Promise<User[]> {
  return await db.select().from(schema.users).orderBy(asc(schema.users.username));
}

export async function updateUser(id: string, updates: Partial<InsertUser>): Promise<User> {
  const [user] = await db.update(schema.users).set(updates).where(eq(schema.users.id, id)).returning();
  return user;
}

export async function deleteUser(id: string): Promise<void> {
  await db.delete(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.userId, id));
  await db.delete(schema.users).where(eq(schema.users.id, id));
}

export async function getUserCompanyRole(
  userId: string,
  companyId: number
): Promise<schema.UserCompanyRole | undefined> {
  const [role] = await db
    .select()
    .from(schema.userCompanyRoles)
    .where(and(eq(schema.userCompanyRoles.userId, userId), eq(schema.userCompanyRoles.companyId, companyId)));
  return role;
}

// Companies

export async function getAllCompanies(): Promise<Company[]> {
  return await db.select().from(schema.companies).orderBy(asc(schema.companies.name));
}

export async function getCompanyById(id: number): Promise<Company | undefined> {
  const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, id));
  return company;
}

/**
 * Phase 23 (C1): the company, its standard chart of accounts
 * (chartOfAccountsTemplate.ts) and the audit row are written in one
 * transaction. The new company's accounts are written in its own tenant scope:
 * it did not exist when the request scope was resolved, so the scope is set on
 * this transaction only (set_config is transaction-local).
 */
export async function createCompany(
  company: InsertCompany,
  actor?: { userId?: string | null; username?: string | null }
): Promise<Company> {
  const { provisionChartOfAccountsTemplateTx } = await import("../services/accounting/chartOfAccountsTemplate");
  const { writeAuditEvent } = await import("../services/audit");
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(schema.companies).values(company).returning();
    await tx.execute(sql`SELECT set_config('app.current_company_id', ${String(created.id)}, true)`);
    const chart = await provisionChartOfAccountsTemplateTx(tx, created.id);
    await writeAuditEvent(
      {
        userId: actor?.userId ?? undefined,
        username: actor?.username || "system",
        companyId: created.id,
        action: "create",
        tableName: "companies",
        recordId: created.id,
        recordIdentifier: created.code,
        changes: {
          name: { old: null, new: created.name },
          chartOfAccountsTemplate: { old: null, new: chart.version },
          accountsCreated: { old: null, new: chart.created.map((account) => account.code) },
        },
      },
      tx
    );
    return created;
  });
}

export async function updateCompany(id: number, updates: Partial<InsertCompany>): Promise<Company> {
  const [updated] = await db.update(schema.companies).set(updates).where(eq(schema.companies.id, id)).returning();
  return updated;
}

/**
 * Wave 12 (owner decision 4): the hand-maintained cascade that lived here
 * deleted fiscal closures first, hard-deleted every voucher, deleted audit_log
 * and ran without a transaction or an audit row. It is retired: this delegates
 * to the guarded, transactional, audited implementation in company-deletion.ts
 * (which server/storage.ts already preferred), so every caller of this module
 * gets the same refusal for a company with history.
 */
export async function deleteCompany(
  id: number,
  actor?: import("./company-deletion").CompanyDeletionActor
): Promise<void> {
  const { deleteCompany: deleteEmptyCompany } = await import("./company-deletion");
  await deleteEmptyCompany(id, actor);
}

// User-Company Roles

export async function getUserCompaniesWithRoles(userId: string): Promise<UserCompanyRole[]> {
  return await db.select().from(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.userId, userId));
}

// Phase 21 (B): the role writers take an optional executor so the route audits in the same transaction.
export async function createUserCompanyRole(
  role: InsertUserCompanyRole,
  executor: DatabaseOrTransaction = db
): Promise<UserCompanyRole> {
  const [created] = await executor.insert(schema.userCompanyRoles).values(role).returning();
  return created;
}

export async function updateUserCompanyRole(
  id: number,
  updates: Partial<InsertUserCompanyRole>,
  executor: DatabaseOrTransaction = db
): Promise<UserCompanyRole> {
  const [updated] = await executor
    .update(schema.userCompanyRoles)
    .set(updates)
    .where(eq(schema.userCompanyRoles.id, id))
    .returning();
  return updated;
}

export async function deleteUserCompanyRole(id: number, executor: DatabaseOrTransaction = db): Promise<void> {
  await executor.delete(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.id, id));
}

// System Settings

export async function getSystemSetting(key: string): Promise<schema.SystemSetting | undefined> {
  const [setting] = await db.select().from(schema.systemSettings).where(eq(schema.systemSettings.key, key));
  return setting;
}

export async function setSystemSetting(key: string, value: string | null): Promise<schema.SystemSetting> {
  const existing = await getSystemSetting(key);
  if (existing) {
    const [updated] = await db
      .update(schema.systemSettings)
      .set({ value, updatedAt: sql`now()` })
      .where(eq(schema.systemSettings.key, key))
      .returning();
    return updated;
  } else {
    const [created] = await db.insert(schema.systemSettings).values({ key, value }).returning();
    return created;
  }
}

/**
 * The parent company (accounting audit phase 26, MC-7, decided by default):
 * `companies.parent_company_id` is the ONE parent model. The global system
 * setting `parentCompanyId` (one parent for the whole installation) is retired
 * and no longer read; container/PO postings used it while the engine and the
 * group reports used the companies column, so the two could disagree.
 *
 *   - with a company: that company's parent; the company itself when it is a
 *     parent of other companies (a parent's own PO is a same-company sync);
 *     null for a standalone company;
 *   - without a company (legacy callers that have none): the group parent when
 *     exactly one top-level company has subsidiaries, else null (ambiguous or
 *     no group: callers treat it as "no parent configured").
 */
export async function getParentCompanyId(companyId?: number | null): Promise<number | null> {
  const rows = await db
    .select({ id: schema.companies.id, parentCompanyId: schema.companies.parentCompanyId })
    .from(schema.companies);
  const parentIds = new Set(rows.map((row) => row.parentCompanyId).filter((id): id is number => !!id));
  if (companyId) {
    const company = rows.find((row) => row.id === companyId);
    if (!company) return null;
    if (company.parentCompanyId) return company.parentCompanyId;
    return parentIds.has(company.id) ? company.id : null;
  }
  const topLevelParents = rows.filter((row) => !row.parentCompanyId && parentIds.has(row.id));
  return topLevelParents.length === 1 ? topLevelParents[0].id : null;
}

/** Retired with the global setting (phase 26, MC-7): only clears the stored legacy value. */
export async function setParentCompanyId(companyId: number | null): Promise<void> {
  await setSystemSetting("parentCompanyId", companyId?.toString() ?? null);
}

// Role Feature Permissions

export async function getRoleFeaturePermissions(companyId: number): Promise<schema.RoleFeaturePermission[]> {
  return await db
    .select()
    .from(schema.roleFeaturePermissions)
    .where(eq(schema.roleFeaturePermissions.companyId, companyId));
}

export async function getRoleFeaturePermission(
  companyId: number,
  role: string,
  featureKey: string
): Promise<schema.RoleFeaturePermission | undefined> {
  const [permission] = await db
    .select()
    .from(schema.roleFeaturePermissions)
    .where(
      and(
        eq(schema.roleFeaturePermissions.companyId, companyId),
        eq(schema.roleFeaturePermissions.role, role),
        eq(schema.roleFeaturePermissions.featureKey, featureKey)
      )
    );
  return permission;
}

export async function upsertRoleFeaturePermission(
  permission: schema.InsertRoleFeaturePermission
): Promise<schema.RoleFeaturePermission> {
  const [result] = await db
    .insert(schema.roleFeaturePermissions)
    .values(permission)
    .onConflictDoUpdate({
      target: [
        schema.roleFeaturePermissions.companyId,
        schema.roleFeaturePermissions.role,
        schema.roleFeaturePermissions.featureKey,
      ],
      set: {
        enabled: permission.enabled,
        updatedAt: new Date(),
      },
    })
    .returning();
  return result;
}

export async function bulkUpsertRoleFeaturePermissions(
  permissions: schema.InsertRoleFeaturePermission[]
): Promise<schema.RoleFeaturePermission[]> {
  if (permissions.length === 0) return [];
  const results: schema.RoleFeaturePermission[] = [];
  for (const permission of permissions) {
    const result = await upsertRoleFeaturePermission(permission);
    results.push(result);
  }
  return results;
}

// ERP User Page Access

export async function getErpUserPageAccess(companyId: number, userId: string): Promise<string[]> {
  const rows = await db
    .select({ pageKey: schema.erpUserPageAccess.pageKey })
    .from(schema.erpUserPageAccess)
    .where(and(eq(schema.erpUserPageAccess.companyId, companyId), eq(schema.erpUserPageAccess.userId, userId)));
  return rows.map((r) => r.pageKey);
}

export async function setErpUserPageAccess(companyId: number, userId: string, pageKeys: string[]): Promise<void> {
  await db
    .delete(schema.erpUserPageAccess)
    .where(and(eq(schema.erpUserPageAccess.companyId, companyId), eq(schema.erpUserPageAccess.userId, userId)));
  if (pageKeys.length > 0) {
    await db.insert(schema.erpUserPageAccess).values(pageKeys.map((pageKey) => ({ companyId, userId, pageKey })));
  }
}

export async function getErpUserHiddenCostFields(userId: string): Promise<string[]> {
  const [user] = await db
    .select({ hiddenErpCostFields: schema.users.hiddenErpCostFields })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return user?.hiddenErpCostFields ?? [];
}

export async function setErpUserHiddenCostFields(userId: string, fields: string[]): Promise<void> {
  await db.update(schema.users).set({ hiddenErpCostFields: fields }).where(eq(schema.users.id, userId));
}
