/**
 * Permissions Control Center V2 — operator switches for the role/user matrix.
 *
 * Two independent switches, both off unless an operator sets them after the
 * release gates in config/permissions-v2-release-readiness.json are verified
 * and the owner approves:
 *
 * - PERMISSIONS_V2_COMPANY_ACTIVATION=enabled lets a company administrator move
 *   that company's V2 policy from shadow to active. Moving back to shadow or
 *   rolled_back is always allowed, so a rollback never waits for a deploy.
 * - PERMISSIONS_V2_ENFORCEMENT=enabled lets an active company's V2 rules
 *   restrict requests. While it is off, V2 never changes any decision and the
 *   enforcement middleware does no database work.
 *
 * Neither switch can widen access: V2 is restrict-only (see
 * shared/effectivePermissions.ts).
 */
import type { V2PolicyMode } from "@shared/effectivePermissions";

export function isV2CompanyActivationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PERMISSIONS_V2_COMPANY_ACTIVATION === "enabled";
}

export function isV2EnforcementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PERMISSIONS_V2_ENFORCEMENT === "enabled";
}

export interface V2ModeTransitionRefusal {
  status: 409 | 400;
  code: "PERMISSIONS_V2_ACTIVATION_NOT_AUTHORIZED" | "POLICY_MODE_UNCHANGED";
  message: string;
}

/** Decide whether an administrator may move a company from one mode to another. */
export function refuseV2ModeTransition(
  from: V2PolicyMode,
  to: V2PolicyMode,
  env: NodeJS.ProcessEnv = process.env
): V2ModeTransitionRefusal | null {
  if (from === to) {
    return { status: 400, code: "POLICY_MODE_UNCHANGED", message: "The company policy is already in this mode." };
  }
  if (to === "active" && !isV2CompanyActivationEnabled(env)) {
    return {
      status: 409,
      code: "PERMISSIONS_V2_ACTIVATION_NOT_AUTHORIZED",
      message: "Company activation of the V2 permission matrix has not been authorized.",
    };
  }
  return null;
}
