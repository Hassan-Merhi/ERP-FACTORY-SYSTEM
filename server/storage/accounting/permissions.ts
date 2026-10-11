import { eq, and } from "drizzle-orm";
import { db, type DatabaseOrTransaction } from "../../db";
import * as schema from "@shared/schema";

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
  permission: schema.InsertRoleFeaturePermission,
  executor: DatabaseOrTransaction = db
): Promise<schema.RoleFeaturePermission> {
  const [result] = await executor
    .insert(schema.roleFeaturePermissions)
    .values(permission)
    .onConflictDoUpdate({
      target: [
        schema.roleFeaturePermissions.companyId,
        schema.roleFeaturePermissions.role,
        schema.roleFeaturePermissions.featureKey,
      ],
      set: { enabled: permission.enabled, updatedAt: new Date() },
    })
    .returning();
  return result;
}

export async function bulkUpsertRoleFeaturePermissions(
  permissions: schema.InsertRoleFeaturePermission[],
  // Phase 21 (B): the caller's transaction, so its audit rows commit with the upserts.
  executor: DatabaseOrTransaction = db
): Promise<schema.RoleFeaturePermission[]> {
  if (permissions.length === 0) return [];
  const results: schema.RoleFeaturePermission[] = [];
  for (const permission of permissions) {
    const result = await upsertRoleFeaturePermission(permission, executor);
    results.push(result);
  }
  return results;
}

// ---------------------------------------------------------------------------
// ERP User Page Access
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// System Settings + Parent Company ID cache
// ---------------------------------------------------------------------------
