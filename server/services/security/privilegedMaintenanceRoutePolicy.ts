export const PRIVILEGED_MAINTENANCE_PERMISSION = "administration.repair";

export type PrivilegedMaintenanceOperation =
  | "repair"
  | "recalculate"
  | "rebuild"
  | "cleanup"
  | "backfill"
  | "reconcile"
  | "resync"
  | "fix";

export interface PrivilegedMaintenanceRouteMatch {
  operation: PrivilegedMaintenanceOperation;
  permission: typeof PRIVILEGED_MAINTENANCE_PERMISSION;
}

export type PrivilegedMaintenanceAccessDecision =
  | { allowed: true; code: "AUTHORIZED" }
  | {
      allowed: false;
      code:
        | "PRIVILEGED_MAINTENANCE_ROLE_REQUIRED"
        | "PRIVILEGED_MAINTENANCE_PERMISSION_REQUIRED";
    };

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const OPERATION_PATTERN =
  /(?:^|[-/])(repair|recalculate|rebuild|cleanup|backfill|reconcile|reconciliation|resync|fix)(?:[-/]|$)/;

function normalizePath(rawPath: string): string {
  const path = rawPath.split("?", 1)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "").toLowerCase() : path;
}

/**
 * Classify legacy maintenance mutations that can rewrite or delete business
 * state. Ordinary business writes are deliberately excluded; the existing
 * route-level and operational permission gates remain authoritative for them.
 */
export function classifyPrivilegedMaintenanceRoute(
  method: string,
  rawPath: string
): PrivilegedMaintenanceRouteMatch | null {
  if (!MUTATION_METHODS.has(method.toUpperCase())) return null;

  const path = normalizePath(rawPath);
  if (!path.startsWith("/api/")) return null;

  const match = path.match(OPERATION_PATTERN);
  if (!match) return null;

  const operation = match[1] === "reconciliation" ? "reconcile" : match[1];
  return {
    operation: operation as PrivilegedMaintenanceOperation,
    permission: PRIVILEGED_MAINTENANCE_PERMISSION,
  };
}

/**
 * Developer remains the explicit global support/break-glass role. An Admin is
 * company-bound and must carry the exact named repair permission for that
 * company. Owner/Manager/POS/Normal User are never admitted to maintenance
 * mutations even when an older route still names one of those roles.
 */
export function decidePrivilegedMaintenanceAccess(input: {
  role: string | null | undefined;
  developerBypass: boolean;
  permissions: readonly string[];
}): PrivilegedMaintenanceAccessDecision {
  if (input.role === "Developer" && input.developerBypass) {
    return { allowed: true, code: "AUTHORIZED" };
  }

  if (input.role !== "Admin") {
    return { allowed: false, code: "PRIVILEGED_MAINTENANCE_ROLE_REQUIRED" };
  }

  if (!input.permissions.includes(PRIVILEGED_MAINTENANCE_PERMISSION)) {
    return {
      allowed: false,
      code: "PRIVILEGED_MAINTENANCE_PERMISSION_REQUIRED",
    };
  }

  return { allowed: true, code: "AUTHORIZED" };
}
