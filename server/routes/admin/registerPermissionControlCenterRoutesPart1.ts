// Extracted from ./permissionControlCenterRoutes.ts
import type { Express } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { ACCESS_CONTROL_ACTIONS, ACCESS_CONTROL_RESOURCES } from "@shared/accessControlV2";
import {
  V2_EDITABLE_ROLES,
  assignedCompanyRole,
  readV2Roles,
  readV2UserPolicy,
  readV2CompanyMembers,
} from "../../services/security/accessControlV2Store";
import { isCreateOnlyAssignmentEnabled } from "../../services/security/createOnlyActivation";
import { requirePolicyAdmin, handle } from "./permissionControlCenterRoutesHelpers";

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
