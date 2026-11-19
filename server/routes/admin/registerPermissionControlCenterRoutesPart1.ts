// Extracted from ./permissionControlCenterRoutes.ts
import type { Express, Request, Response } from "express";
import { z, ZodError } from "zod";
import { requireAuth } from "../../auth";
import {
  getActiveCompanyPermissionContext,
  ActiveCompanyPermissionContextError,
} from "../../services/security/activeCompanyPermissionContext";
import { ACCESS_CONTROL_ACTIONS, ACCESS_CONTROL_RESOURCES } from "@shared/accessControlV2";
import {
  V2_EDITABLE_ROLES,
  V2PolicyError,
  assignedCompanyRole,
  readV2Roles,
  readV2UserPolicy,
  readV2CompanyMembers,
} from "../../services/security/accessControlV2Store";
import { isCreateOnlyAssignmentEnabled } from "../../services/security/createOnlyActivation";
import { recordPermissionSignal } from "../../services/security/permissionMonitor";

type CompanyAdmin = { companyId: number; userId: string };

export async function requirePolicyAdmin(req: Request): Promise<CompanyAdmin> {
  const c = await getActiveCompanyPermissionContext(req);
  if (c.role !== "Admin" && c.role !== "Developer") {
    throw new V2PolicyError(403, "POLICY_ADMIN_REQUIRED", "Company administrator access required");
  }
  return { companyId: c.companyId, userId: c.userId };
}

function handleV2Error(error: unknown, res: Response, req?: Request): void {
  if (error instanceof V2PolicyError) {
    if (error.code === "POLICY_STALE_REVISION") {
      recordPermissionSignal({
        kind: "policy_revision_conflict",
        code: error.code,
        companyId: req?.session?.currentCompanyId ?? null,
        userId: req?.session?.userId ?? null,
        method: req?.method,
        path: req?.path,
      });
    }
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof ActiveCompanyPermissionContextError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ code: "INVALID_POLICY_INPUT", message: "INVALID_POLICY_INPUT", issues: error.issues });
    return;
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "42P01" || code === "42703" || code === "42883") {
    res.status(503).json({
      code: "ACCESS_POLICY_SCHEMA_REQUIRED",
      message: "ACCESS_POLICY_SCHEMA_REQUIRED",
    });
    return;
  }
  if (code === "23514" || code === "23503" || code === "23505") {
    res.status(409).json({ code: "ACCESS_POLICY_CONSTRAINT", message: "ACCESS_POLICY_CONSTRAINT" });
    return;
  }
  // Do not leak queries, user IDs, table names or DB state in HTTP responses.
  recordPermissionSignal({
    kind: "permission_service_error",
    code: "ACCESS_POLICY_UNAVAILABLE",
    companyId: req?.session?.currentCompanyId ?? null,
    userId: req?.session?.userId ?? null,
    method: req?.method,
    path: req?.path,
  });
  res.status(500).json({ code: "ACCESS_POLICY_UNAVAILABLE", message: "ACCESS_POLICY_UNAVAILABLE" });
}

export function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    void fn(req, res).catch((error: unknown) => handleV2Error(error, res, req));
  };
}

export function registerPermissionControlCenterRoutesPart1(app: Express) {
  app.get(
    "/api/permissions-v2/catalog",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      res.json({
        companyId: actor.companyId,
        actions: ACCESS_CONTROL_ACTIONS,
        resources: ACCESS_CONTROL_RESOURCES,
        editableRoles: V2_EDITABLE_ROLES,
        mode: "shadow",
        enforced: false,
        // The Create Only write boundary is always enforced; this only says
        // whether administrators may assign the role to people yet.
        createOnlyAssignable: isCreateOnlyAssignmentEnabled(),
      });
    })
  );

  app.get(
    "/api/permissions-v2/roles",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      res.json({ companyId: actor.companyId, ...(await readV2Roles(actor.companyId)) });
    })
  );

  app.get(
    "/api/permissions-v2/users",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      res.json({
        companyId: actor.companyId,
        users: await readV2CompanyMembers(actor.companyId),
        mode: "shadow",
        enforced: false,
      });
    })
  );

  app.get(
    "/api/permissions-v2/users/:userId/overrides",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      const userId = z.string().min(1).max(128).parse(req.params.userId);
      const role = await assignedCompanyRole(actor.companyId, userId);
      res.json({
        companyId: actor.companyId,
        userId,
        role,
        ...(await readV2UserPolicy(actor.companyId, userId)),
        enforced: false,
      });
    })
  );
}
