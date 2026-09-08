import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { userCompanyRoles } from "@shared/schema";
import { db, pool } from "../db";
import { logger } from "../lib/logger";
import { resolveActiveCompanyId } from "../routes/helpers/resolveActiveCompanyId";
import { enforceGlobalMaintenanceScope } from "./globalMaintenanceScope";
import { enforceIntercompanyConfigurationScope } from "./intercompanyConfigurationScope";
import { enforceUserLocationConfigurationScope } from "./userLocationConfigurationScope";
import {
  canAccessTargetUser,
  canAssignCompany,
  canAssignExistingTargetUser,
  canAssignRole,
  canMutateGlobalUserAccount,
  filterRolesForCompany,
  visibleUserIdsForCompany,
  type CompanyUserRoleRow,
} from "../services/security/companyUserAdminScopePolicy";
import { asRecord } from "@shared/typeGuards";

function hasCompanyId(row: unknown): row is { companyId: number } {
  return typeof asRecord(row)?.companyId === "number";
}

async function loadRoleRows(userId?: string): Promise<CompanyUserRoleRow[]> {
  const query = db
    .select({
      userId: userCompanyRoles.userId,
      companyId: userCompanyRoles.companyId,
      role: userCompanyRoles.role,
    })
    .from(userCompanyRoles);

  return userId ? await query.where(eq(userCompanyRoles.userId, userId)) : await query;
}

/**
 * Filter an array JSON response before it leaves the process.
 *
 * The rows are whatever the downstream handler serialized, so they are
 * genuinely `unknown` here — each filter narrows the fields it depends on
 * rather than assuming a shape this middleware never validated.
 */
function installJsonArrayFilter(res: Response, filter: (rows: unknown[]) => unknown[]): void {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => originalJson(Array.isArray(body) ? filter(body) : body);
}

function deny(req: Request, res: Response, companyId: number, reason: string, message: string, status = 404): false {
  logger.error(
    JSON.stringify({
      event: "company_user_role_scope_denied",
      ts: new Date().toISOString(),
      userId: req.session.userId ?? null,
      role: req.session.currentRole ?? null,
      companyId,
      method: req.method,
      path: req.path,
      reason,
    })
  );
  res.status(status).json({ message });
  return false;
}

export async function enforceCompanyUserRoleScope(req: Request, res: Response): Promise<boolean> {
  // This middleware is the first Program 3A gateway registered before legacy
  // routes, so globally destructive maintenance, two-company configuration, and
  // company-owned user-location checks run here as well.
  if (!enforceGlobalMaintenanceScope(req, res)) return false;
  if (!(await enforceIntercompanyConfigurationScope(req, res))) return false;
  if (!(await enforceUserLocationConfigurationScope(req, res))) return false;

  const sessionUserId = req.session.userId;
  const actorRole = req.session.currentRole;
  const companyId = resolveActiveCompanyId(req);
  if (!sessionUserId || !actorRole || !companyId) return true;

  const method = req.method.toUpperCase();
  const path = req.path;

  if (method === "GET" && path === "/api/users") {
    const roleRows = await loadRoleRows();
    const visibleIds = visibleUserIdsForCompany(roleRows, companyId);
    installJsonArrayFilter(res, (rows) =>
      rows.filter((row) => {
        const id = asRecord(row)?.id;
        return typeof id === "string" && visibleIds.has(id);
      })
    );
    return true;
  }

  if (method === "GET" && path === "/api/sessions" && actorRole !== "Developer") {
    const roleRows = await loadRoleRows();
    const userIds = [...new Set(roleRows.map((row) => row.userId))];
    const visibleSessionUserIds = new Set(
      userIds.filter((targetUserId) => canMutateGlobalUserAccount(roleRows, targetUserId, companyId, actorRole))
    );
    visibleSessionUserIds.add(sessionUserId);
    installJsonArrayFilter(res, (rows) =>
      rows.filter((row) => {
        const userId = asRecord(row)?.userId;
        return typeof userId === "string" && visibleSessionUserIds.has(userId);
      })
    );
    return true;
  }

  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (method === "DELETE" && sessionMatch && actorRole !== "Developer") {
    const sid = decodeURIComponent(sessionMatch[1]);
    const result = await pool.query(`SELECT sess FROM session WHERE sid = $1`, [sid]);
    const targetUserId = result.rows[0]?.sess?.userId;
    if (!targetUserId) return true;
    if (targetUserId === sessionUserId) return true;

    const targetRows = await loadRoleRows(targetUserId);
    if (!canMutateGlobalUserAccount(targetRows, targetUserId, companyId, actorRole)) {
      return deny(req, res, companyId, "SESSION_TARGET_SCOPE_DENIED", "Session not found");
    }
    return true;
  }

  const rolesMatch = path.match(/^\/api\/users\/([^/]+)\/company-roles$/);
  if (method === "GET" && rolesMatch) {
    const targetUserId = decodeURIComponent(rolesMatch[1]);
    const targetRows = await loadRoleRows(targetUserId);
    if (!canAccessTargetUser(targetRows, targetUserId, companyId, actorRole)) {
      return deny(req, res, companyId, "USER_COMPANY_SCOPE_DENIED", "User not found");
    }
    // Rows without a numeric companyId could never match the active company, so
    // dropping them in the guard leaves the filtered result unchanged.
    installJsonArrayFilter(res, (rows) => filterRolesForCompany(rows.filter(hasCompanyId), companyId));
    return true;
  }

  const permissionMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/security-permissions$/);
  if (["GET", "PUT"].includes(method) && permissionMatch) {
    const targetUserId = decodeURIComponent(permissionMatch[1]);
    const targetRows = await loadRoleRows(targetUserId);
    if (!canAccessTargetUser(targetRows, targetUserId, companyId, actorRole)) {
      return deny(req, res, companyId, "SECURITY_PERMISSION_TARGET_SCOPE_DENIED", "User not found");
    }
    return true;
  }

  const userMatch = path.match(/^\/api\/users\/([^/]+)$/);
  const resetPasswordMatch = path.match(/^\/api\/admin\/reset-password\/([^/]+)$/);
  const globalUserMutationId =
    userMatch && ["PATCH", "DELETE"].includes(method)
      ? decodeURIComponent(userMatch[1])
      : resetPasswordMatch && method === "POST"
        ? decodeURIComponent(resetPasswordMatch[1])
        : null;

  if (globalUserMutationId) {
    const targetRows = await loadRoleRows(globalUserMutationId);
    if (!canMutateGlobalUserAccount(targetRows, globalUserMutationId, companyId, actorRole)) {
      return deny(req, res, companyId, "GLOBAL_USER_MUTATION_SCOPE_DENIED", "User not found");
    }
    return true;
  }

  if (method === "POST" && path === "/api/user-company-roles") {
    const body = req.body as Record<string, unknown> | undefined;
    if (body?.companyId !== undefined && !canAssignCompany(actorRole, body.companyId, companyId)) {
      return deny(req, res, companyId, "ROLE_COMPANY_SCOPE_DENIED", "You don't have access to this company", 403);
    }
    if (!canAssignRole(actorRole, body?.role)) {
      return deny(
        req,
        res,
        companyId,
        "DEVELOPER_ROLE_ASSIGNMENT_DENIED",
        "Only a Developer can assign the Developer role",
        403
      );
    }

    const targetUserId = body?.userId;
    if (typeof targetUserId === "string" && targetUserId.length > 0) {
      const targetRows = await loadRoleRows(targetUserId);
      if (!canAssignExistingTargetUser(targetRows, targetUserId, actorRole)) {
        return deny(req, res, companyId, "ROLE_TARGET_SCOPE_DENIED", "User not found");
      }
    }
    return true;
  }

  const roleMatch = path.match(/^\/api\/user-company-roles\/(\d+)$/);
  if (roleMatch && ["PATCH", "DELETE"].includes(method)) {
    const roleId = Number(roleMatch[1]);
    const [targetRole] = await db
      .select({
        userId: userCompanyRoles.userId,
        companyId: userCompanyRoles.companyId,
      })
      .from(userCompanyRoles)
      .where(eq(userCompanyRoles.id, roleId))
      .limit(1);

    if (!targetRole || targetRole.companyId !== companyId) {
      return deny(req, res, companyId, "ROLE_RECORD_SCOPE_DENIED", "Role not found");
    }

    const targetRows = await loadRoleRows(targetRole.userId);
    if (!canAccessTargetUser(targetRows, targetRole.userId, companyId, actorRole)) {
      return deny(req, res, companyId, "ROLE_TARGET_SCOPE_DENIED", "Role not found");
    }

    const requestedRole = (req.body as Record<string, unknown> | undefined)?.role;
    if (!canAssignRole(actorRole, requestedRole)) {
      return deny(
        req,
        res,
        companyId,
        "DEVELOPER_ROLE_ASSIGNMENT_DENIED",
        "Only a Developer can assign the Developer role",
        403
      );
    }
  }

  return true;
}
