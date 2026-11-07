/**
 * Phase 2 admin API. All paths are company-scoped and SHADOW ONLY.
 * Uses canonical active company membership; never accepts browser companyId.
 * Missing explicit migration returns 503, never creates tables at startup.
 */
import type { Express, Request, Response } from "express";
import { z, ZodError } from "zod";
import { requireAuth } from "../../auth";
import {
  getActiveCompanyPermissionContext,
  ActiveCompanyPermissionContextError,
} from "../../services/security/activeCompanyPermissionContext";
import {
  ACCESS_CONTROL_ACTIONS,
  ACCESS_CONTROL_RESOURCES,
  type AccessControlAction,
  type AccessControlResource,
} from "@shared/accessControlV2";
import {
  V2_EDITABLE_ROLES,
  V2PolicyError,
  assignedCompanyRole,
  previewV2,
  readV2Audit,
  readV2Revision,
  readV2Roles,
  readV2UserPolicy,
  readV2CompanyMembers,
  saveV2Rules,
} from "../../services/security/accessControlV2Store";
import { isCreateOnlyAssignmentEnabled } from "../../services/security/createOnlyActivation";
import {
  readEffectivePermissions,
  readV2PolicyStatus,
  setV2PolicyMode,
} from "../../services/security/effectivePermissionStore";
import { isV2CompanyActivationEnabled, isV2EnforcementEnabled } from "../../services/security/permissionsV2Activation";
import { recordPermissionSignal } from "../../services/security/permissionMonitor";
import { computeEffectivePermissions } from "@shared/effectivePermissions";

const changeSchema = z
  .object({
    resource: z.enum(ACCESS_CONTROL_RESOURCES),
    action: z.enum(ACCESS_CONTROL_ACTIONS),
    decision: z.enum(["allow", "deny", "inherit"]),
  })
  .strict();

const saveBase = z
  .object({
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(10).max(500),
    changes: z.array(changeSchema).min(1).max(100),
  })
  .strict();
const roleSave = saveBase
  .extend({
    roleKey: z.enum(V2_EDITABLE_ROLES),
  })
  .strict();
const userSave = saveBase
  .extend({
    userId: z.string().min(1).max(128),
  })
  .strict();
const modeChange = z
  .object({
    mode: z.enum(["shadow", "active", "rolled_back"]),
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
const previewParams = z
  .object({
    userId: z.string().min(1).max(128).optional(),
    role: z.enum(V2_EDITABLE_ROLES).optional(),
    resource: z.enum(ACCESS_CONTROL_RESOURCES),
    action: z.enum(ACCESS_CONTROL_ACTIONS),
  })
  .strict();

type CompanyAdmin = { companyId: number; userId: string };
async function requirePolicyAdmin(req: Request): Promise<CompanyAdmin> {
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

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    void fn(req, res).catch((error: unknown) => handleV2Error(error, res, req));
  };
}

export function registerPermissionControlCenterRoutes(app: Express): void {
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

  app.get(
    "/api/permissions-v2/preview",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      const q = previewParams.parse(req.query);
      const companyRole = q.userId ? await assignedCompanyRole(actor.companyId, q.userId) : null;
      if (q.userId && q.role && q.role !== companyRole) {
        throw new V2PolicyError(400, "POLICY_ROLE_MISMATCH", "Requested role does not match company membership");
      }
      const role = companyRole ?? q.role ?? "Create Only";
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
    })
  );

  app.get(
    "/api/permissions-v2/audit",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      const limit = z.coerce.number().int().min(1).max(100).default(25).parse(req.query.limit);
      res.json({
        companyId: actor.companyId,
        records: await readV2Audit(actor.companyId, limit),
      });
    })
  );

  app.put(
    "/api/permissions-v2/role-rules",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      const body = roleSave.parse(req.body);
      const saved = await saveV2Rules({
        actor,
        subject: { kind: "role", roleKey: body.roleKey },
        expectedRevision: body.expectedRevision,
        changes: body.changes,
        reason: body.reason,
      });
      recordPermissionSignal({
        kind: "policy_change",
        code: "ROLE_RULES_SAVED",
        companyId: actor.companyId,
        userId: actor.userId,
        detail: { revision: saved.revision, applied: saved.applied, subject: body.roleKey },
      });
      res.json(saved);
    })
  );

  app.put(
    "/api/permissions-v2/user-overrides",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      const body = userSave.parse(req.body);
      const saved = await saveV2Rules({
        actor,
        subject: { kind: "user", userId: body.userId },
        expectedRevision: body.expectedRevision,
        changes: body.changes,
        reason: body.reason,
      });
      recordPermissionSignal({
        kind: "policy_change",
        code: "USER_OVERRIDES_SAVED",
        companyId: actor.companyId,
        userId: actor.userId,
        detail: { revision: saved.revision, applied: saved.applied },
      });
      res.json(saved);
    })
  );

  /**
   * Effective permissions of the signed-in person in the active company. The
   * role comes from canonical membership; nothing in the request can choose
   * the company, the user or the role. While V2 is in shadow mode the
   * effective decisions are today's legacy decisions.
   */
  app.get(
    "/api/permissions-v2/me",
    requireAuth,
    handle(async (req, res) => {
      const context = await getActiveCompanyPermissionContext(req);
      if (context.developerBypass) {
        res.json(
          computeEffectivePermissions({
            companyId: context.companyId,
            userId: context.userId,
            role: "Developer",
            legacyModules: {},
            v2: { available: false, mode: "shadow", revision: 0, roleRules: [], userRules: [] },
            enforcementEnabled: false,
          })
        );
        return;
      }
      res.json(await readEffectivePermissions(context.companyId, context.userId));
    })
  );

  app.get(
    "/api/permissions-v2/users/:userId/effective",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      const userId = z.string().min(1).max(128).parse(req.params.userId);
      res.json(await readEffectivePermissions(actor.companyId, userId));
    })
  );

  app.get(
    "/api/permissions-v2/activation",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      const status = await readV2PolicyStatus(actor.companyId);
      res.json({
        companyId: actor.companyId,
        ...status,
        activationAuthorized: isV2CompanyActivationEnabled(),
        enforcementEnabled: isV2EnforcementEnabled(),
        enforced: status.available && status.mode === "active" && isV2EnforcementEnabled(),
      });
    })
  );

  /**
   * Move the active company's V2 policy between shadow, active and
   * rolled_back. Activation needs the operator switch; rollback never does.
   * Revision-checked and audited in one transaction.
   */
  app.put(
    "/api/permissions-v2/activation",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      const body = modeChange.parse(req.body);
      const result = await setV2PolicyMode({
        actor,
        mode: body.mode,
        expectedRevision: body.expectedRevision,
        reason: body.reason,
      });
      recordPermissionSignal({
        kind: "policy_change",
        code: "POLICY_MODE_CHANGED",
        companyId: actor.companyId,
        userId: actor.userId,
        detail: { revision: result.revision, from: result.previousMode, to: result.mode },
      });
      res.json({ companyId: actor.companyId, ...result });
    })
  );
}
