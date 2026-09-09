import type { SessionData } from "express-session";
import { isRecord } from "@shared/typeGuards";
import type { DatabaseOrTransaction, DatabasePool, DbTransaction } from "../../db";
import { and, eq } from "drizzle-orm";
import { userCompanyRoles, userSecurityPermissions } from "@shared/schema";

export const KNOWN_SECURITY_PERMISSIONS = Object.freeze([
  "administration.repair",
  "security.permissions.manage",
  "security.anomalies.read",
  "factory.documents.download",
  "factory.raw-stock.repair",
  "files.download",
  "inventory.cost.view",
] as const);

export type KnownSecurityPermission = (typeof KNOWN_SECURITY_PERMISSIONS)[number];

export class SecuritySchemaUnavailableError extends Error {
  readonly status = 503;
  readonly statusCode = 503;
  readonly code = "SECURITY_SCHEMA_NOT_READY";

  constructor(cause?: unknown) {
    super("Critical security permissions schema is unavailable");
    this.name = "SecuritySchemaUnavailableError";
    this.cause = cause;
  }
}

function postgresErrorCode(error: unknown): string {
  if (!isRecord(error)) return "";
  const cause = error.cause;
  const causeCode = isRecord(cause) ? cause.code : undefined;
  return String(error.code || causeCode || "");
}

function isSecuritySchemaError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code === "42P01" || code === "42703";
}

export function normalizePermissionList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid permissions");
  const known = new Set<string>(KNOWN_SECURITY_PERMISSIONS);
  const normalized = [...new Set(value.map((item) => (typeof item === "string" ? item.trim() : "")))].filter(Boolean);
  if (normalized.some((item) => !known.has(item))) throw new Error("Invalid permissions");
  return normalized.sort();
}

export async function loadNamedPermissions(
  db: DatabaseOrTransaction,
  userId: string,
  companyId: number
): Promise<string[]> {
  try {
    const rows = await db
      .select({ permission: userSecurityPermissions.permission })
      .from(userSecurityPermissions)
      .where(and(eq(userSecurityPermissions.userId, userId), eq(userSecurityPermissions.companyId, companyId)));
    const permissions: string[] = rows.map((row) => String(row.permission));
    return [...new Set(permissions)].sort();
  } catch (error) {
    if (isSecuritySchemaError(error)) throw new SecuritySchemaUnavailableError(error);
    throw error;
  }
}

export async function assertUserBelongsToCompany(
  db: DatabaseOrTransaction,
  userId: string,
  companyId: number
): Promise<void> {
  const [membership] = await db
    .select({ userId: userCompanyRoles.userId })
    .from(userCompanyRoles)
    .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, companyId)))
    .limit(1);
  if (!membership) throw new Error("User not found");
}

export async function replaceNamedPermissions(
  tx: DbTransaction,
  params: { userId: string; companyId: number; permissions: string[]; grantedBy: string }
): Promise<string[]> {
  const permissions = normalizePermissionList(params.permissions);
  await assertUserBelongsToCompany(tx, params.userId, params.companyId);
  await tx
    .delete(userSecurityPermissions)
    .where(
      and(eq(userSecurityPermissions.userId, params.userId), eq(userSecurityPermissions.companyId, params.companyId))
    );
  if (permissions.length) {
    await tx.insert(userSecurityPermissions).values(
      permissions.map((permission) => ({
        userId: params.userId,
        companyId: params.companyId,
        permission,
        grantedBy: params.grantedBy,
        updatedAt: new Date(),
      }))
    );
  }
  return permissions;
}

export async function hydrateSessionNamedPermissions(
  db: DatabaseOrTransaction,
  session: SessionData
): Promise<string[]> {
  const userId = session.userId;
  const companyId = session.currentCompanyId;
  // `typeof companyId === "number"` is what narrows it for the calls below;
  // Number.isSafeInteger(undefined) is already false, so the guard is unchanged.
  if (!userId || typeof companyId !== "number" || !Number.isSafeInteger(companyId) || companyId <= 0) {
    session.securityPermissions = [];
    session.securityPermissionsCompanyId = null;
    return [];
  }
  if (Array.isArray(session.securityPermissions)) {
    if (session.securityPermissionsCompanyId === companyId) return session.securityPermissions;
    if (session.securityPermissionsCompanyId == null) {
      session.securityPermissionsCompanyId = companyId;
      return session.securityPermissions;
    }
  }
  const permissions = await loadNamedPermissions(db, String(userId), companyId);
  session.securityPermissions = permissions;
  session.securityPermissionsCompanyId = companyId;
  return permissions;
}

export async function invalidateUserCompanySessions(
  pool: DatabasePool,
  userId: string,
  companyId: number
): Promise<void> {
  await pool.query(
    `DELETE FROM session WHERE sess->>'userId' = $1 AND COALESCE((sess->>'currentCompanyId')::int, 0) = $2`,
    [userId, companyId]
  );
}
