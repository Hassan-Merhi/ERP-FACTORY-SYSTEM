/**
 * Phase 2 admin API. All paths are company-scoped and SHADOW ONLY.
 * Uses canonical active company membership; never accepts browser companyId.
 * Missing explicit migration returns 503, never creates tables at startup.
 */
import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { getActiveCompanyPermissionContext } from "../../services/security/activeCompanyPermissionContext";
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
  saveV2Rules,
} from "../../services/security/accessControlV2Store";
import {
  readEffectivePermissions,
  readV2PolicyStatus,
  setV2PolicyMode,
} from "../../services/security/effectivePermissionStore";
import { isV2CompanyActivationEnabled, isV2EnforcementEnabled } from "../../services/security/permissionsV2Activation";
import {
  permissionMonitoringConfiguration,
  permissionSignalCounts,
  recordPermissionSignal,
} from "../../services/security/permissionMonitor";
import { getOperationalEventSnapshot } from "../../lib/operationalEvents";
import { computeEffectivePermissions } from "@shared/effectivePermissions";
import { requirePolicyAdmin, handle } from "./permissionControlCenterRoutesHelpers";
import { registerPermissionControlCenterRoutesPart1 } from "./registerPermissionControlCenterRoutesPart1";

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

export function registerPermissionControlCenterRoutes(app: Express): void {
  registerPermissionControlCenterRoutesPart1(app);

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

  /**
   * Permission monitoring for the active company: signal counts since the
   * process started, integrity event totals and whether alerts are routed.
   * Aggregates only; no user names, request data or secrets.
   */
  app.get(
    "/api/permissions-v2/monitoring",
    requireAuth,
    handle(async (req, res) => {
      const actor = await requirePolicyAdmin(req);
      const events = getOperationalEventSnapshot();
      res.json({
        companyId: actor.companyId,
        ...permissionSignalCounts(actor.companyId),
        operationalIntegrityEvents: events.counts.integrity,
        configuration: permissionMonitoringConfiguration(),
        policy: await readV2PolicyStatus(actor.companyId),
      });
    })
  );
}
