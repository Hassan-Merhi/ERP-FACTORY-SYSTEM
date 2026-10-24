/**
 * Phase 2 admin API. All paths are company-scoped and SHADOW ONLY.
 * Uses canonical active company membership; never accepts browser companyId.
 * Missing explicit migration returns 503, never creates tables at startup.
 */
import type { Express, Request, Response } from "express";
import { z, ZodError } from "zod";
import { requireAuth } from "../../auth";
import { getActiveCompanyPermissionContext, ActiveCompanyPermissionContextError } from "../../services/security/activeCompanyPermissionContext";
import {
  ACCESS_CONTROL_ACTIONS, ACCESS_CONTROL_RESOURCES,
  type AccessControlAction, type AccessControlResource,
} from "@shared/accessControlV2";
import {
  V2_EDITABLE_ROLES, V2PolicyError, assignedCompanyRole,
  previewV2, readV2Audit, readV2Overrides, readV2Revision,
  readV2Roles, saveV2Rules,
} from "../../services/security/accessControlV2Store";

const changeSchema = z.object({
  resource: z.enum(ACCESS_CONTROL_RESOURCES),
  action: z.enum(ACCESS_CONTROL_ACTIONS),
  decision: z.enum(["allow", "deny", "inherit"]),
}).strict();

const saveBase = z.object({
  expectedRevision: z.number().int().nonnegative().safe(),
  reason: z.string().trim().min(10).max(500),
  changes: z.array(changeSchema).min(1).max(100),
}).strict();
const roleSave = saveBase.extend({
  roleKey: z.enum(V2_EDITABLE_ROLES),
}).strict();
const userSave = saveBase.extend({
  userId: z.string().min(1).max(128),
}).strict();
const previewParams = z.object({
  userId: z.string().min(1).max(128).optional(),
  role: z.enum(V2_EDITABLE_ROLES).optional(),
  resource: z.enum(ACCESS_CONTROL_RESOURCES),
  action: z.enum(ACCESS_CONTROL_ACTIONS),
}).strict();

type CompanyAdmin = { companyId: number; userId: string };
async function requirePolicyAdmin(req: Request): Promise<CompanyAdmin> {
  const c = await getActiveCompanyPermissionContext(req);
  if (c.role !== "Admin" && c.role !== "Developer") {
    throw new V2PolicyError(403, "POLICY_ADMIN_REQUIRED", "Company administrator access required");
  }
  return { companyId: c.companyId, userId: c.userId };
}

function handleV2Error(error: unknown, res: Response): void {
  if (error instanceof V2PolicyError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof ActiveCompanyPermissionContextError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ code: "INVALID_POLICY_INPUT", message: "Invalid permission request", issues: error.issues });
    return;
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === "42P01" || code === "42703" || code === "42883") {
    res.status(503).json({
      code: "ACCESS_POLICY_SCHEMA_REQUIRED",
      message: "Apply the reviewed Phase 2 permissions SQL migration before using this screen",
    });
    return;
  }
  if (code === "23514" || code === "23503" || code === "23505") {
    res.status(409).json({ code: "ACCESS_POLICY_CONSTRAINT", message: "The policy update conflicts with a company or security constraint" });
    return;
  }
  // Do not leak queries, user IDs, table names or DB state in HTTP responses.
  res.status(500).json({ code: "ACCESS_POLICY_UNAVAILABLE", message: "Permission service could not complete the request" });
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    void fn(req, res).catch((error: unknown) => handleV2Error(error, res));
  };
}

export function registerPermissionControlCenterRoutes(app: Express): void {
  app.get("/api/permissions-v2/catalog", requireAuth, handle(async (req, res) => {
    const actor = await requirePolicyAdmin(req);
    res.json({
      companyId: actor.companyId,
      actions: ACCESS_CONTROL_ACTIONS,
      resources: ACCESS_CONTROL_RESOURCES,
      editableRoles: V2_EDITABLE_ROLES,
      mode: "shadow", enforced: false,
    });
  }));

  app.get("/api/permissions-v2/roles", requireAuth, handle(async (req, res) => {
    const actor = await requirePolicyAdmin(req);
    res.json({ companyId: actor.companyId, ...await readV2Roles(actor.companyId) });
  }));

  app.get("/api/permissions-v2/users/:userId/overrides", requireAuth, handle(async (req, res) => {
    const actor = await requirePolicyAdmin(req);
    const userId = z.string().min(1).max(128).parse(req.params.userId);
    const role = await assignedCompanyRole(actor.companyId, userId);
    res.json({
      companyId: actor.companyId, userId, role,
      policy: await readV2Revision(actor.companyId),
      rules: await readV2Overrides(actor.companyId, userId),
      enforced: false,
    });
  }));

  app.get("/api/permissions-v2/preview", requireAuth, handle(async (req, res) => {
    const actor = await requirePolicyAdmin(req);
    const q = previewParams.parse(req.query);
    const companyRole = q.userId ? await assignedCompanyRole(actor.companyId, q.userId) : null;
    const role = q.role ?? companyRole ?? "Create Only";
    const v = await readV2Revision(actor.companyId);
    res.json({
      policy: v,
      ...(await previewV2({
        companyId: actor.companyId,
        userId: q.userId,
        role,
        resource: q.resource as AccessControlResource,
        action: q.action as AccessControlAction,
      })),
    });
  }));

  app.get("/api/permissions-v2/audit", requireAuth, handle(async (req, res) => {
    const actor = await requirePolicyAdmin(req);
    const limit = z.coerce.number().int().min(1).max(100).default(25).parse(req.query.limit);
    res.json({
      companyId: actor.companyId,
      records: await readV2Audit(actor.companyId, limit),
    });
  }));

  app.put("/api/permissions-v2/role-rules", requireAuth, handle(async (req, res) => {
    const actor = await requirePolicyAdmin(req);
    const body = roleSave.parse(req.body);
    res.json(await saveV2Rules({
      actor,
      subject: { kind: "role", roleKey: body.roleKey },
      expectedRevision: body.expectedRevision,
      changes: body.changes,
      reason: body.reason,
    }));
  }));

  app.put("/api/permissions-v2/user-overrides", requireAuth, handle(async (req, res) => {
    const actor = await requirePolicyAdmin(req);
    const body = userSave.parse(req.body);
    res.json(await saveV2Rules({
      actor,
      subject: { kind: "user", userId: body.userId },
      expectedRevision: body.expectedRevision,
      changes: body.changes,
      reason: body.reason,
    }));
  }));
}
