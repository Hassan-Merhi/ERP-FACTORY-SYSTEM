import { eq, and, sql, asc } from "drizzle-orm";
import { db } from "../db";
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

export async function createCompany(company: InsertCompany): Promise<Company> {
  const [created] = await db.insert(schema.companies).values(company).returning();
  return created;
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

export async function createUserCompanyRole(role: InsertUserCompanyRole): Promise<UserCompanyRole> {
  const [created] = await db.insert(schema.userCompanyRoles).values(role).returning();
  return created;
}

export async function updateUserCompanyRole(
  id: number,
  updates: Partial<InsertUserCompanyRole>
): Promise<UserCompanyRole> {
  const [updated] = await db
    .update(schema.userCompanyRoles)
    .set(updates)
    .where(eq(schema.userCompanyRoles.id, id))
    .returning();
  return updated;
}

export async function deleteUserCompanyRole(id: number): Promise<void> {
  await db.delete(schema.userCompanyRoles).where(eq(schema.userCompanyRoles.id, id));
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

// 5-minute in-memory cache for the parent company ID setting.
let _parentCompanyIdCache: { value: number | null; expiresAt: number } | null = null;
const _PARENT_ID_TTL_MS = 5 * 60 * 1000;

export async function getParentCompanyId(): Promise<number | null> {
  const now = Date.now();
  if (_parentCompanyIdCache && now < _parentCompanyIdCache.expiresAt) {
    return _parentCompanyIdCache.value;
  }
  const setting = await getSystemSetting("parentCompanyId");
  const value = setting?.value ? parseInt(setting.value, 10) || null : null;
  _parentCompanyIdCache = { value, expiresAt: now + _PARENT_ID_TTL_MS };
  return value;
}

export async function setParentCompanyId(companyId: number | null): Promise<void> {
  _parentCompanyIdCache = null;
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
