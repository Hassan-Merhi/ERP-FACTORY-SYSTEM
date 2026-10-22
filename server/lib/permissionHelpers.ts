/**
 * Server-side permission helper functions.
 *
 * These helpers interpret the role_feature_permissions table with the
 * correct semantics for each role tier:
 *
 *   Developer / Admin     → always allowed (cannot be restricted via this system)
 *   Owner / Manager / POS → allowed by default; enabled=false in DB = restricted
 *   Normal User           → denied by default; enabled=true in DB = explicitly allowed
 *   ERP Tester            → operational access within sandbox; Settings and non-ERP modules always denied
 *
 * Usage pattern:
 *   const permissions = await storage.getRoleFeaturePermissions(companyId);
 *   const permMap = buildPermissionMap(permissions, req.user.role);
 *   if (!canAccessPage(req.user.role, "page_dashboard", permMap)) { return 403; }
 */

export type PermissionRow = {
  role: string;
  featureKey: string;
  enabled: boolean;
};

/**
 * Build a fast lookup map from raw permission rows for a given role.
 * Returns: featureKey → enabled
 */
export function buildPermissionMap(permissions: PermissionRow[], role: string): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const p of permissions) {
    if (p.role === role) {
      map.set(p.featureKey, p.enabled);
    }
  }
  return map;
}

/**
 * Core access check. Interprets permission semantics per role tier.
 */
function isAllowed(role: string, featureKey: string, permMap: Map<string, boolean>): boolean {
  // Developer and Admin are always allowed — cannot be restricted
  if (role === "Developer" || role === "Admin") return true;

  // A sandbox tester cannot be granted Settings or non-ERP access through configurable permissions.
  if (
    role === "ERP Tester" &&
    ["settings", "page_settings", "mod_settings", "factory_production", "mod_factory", "mod_properties"].includes(
      featureKey
    )
  ) {
    return false;
  }

  const stored = permMap.get(featureKey);

  if (role === "Normal User") {
    // Deny-by-default: only allow if there is an explicit enabled=true record
    return stored === true;
  }

  // Owner / Manager / POS / View Only: allow-by-default for read access.
  // Block only when an explicit enabled=false record exists.
  // (Write operations for View Only are blocked globally before they reach here.)
  return stored !== false;
}

/** Check access to a top-level module (e.g. "mod_erp", "mod_factory") */
export function canAccessModule(role: string, moduleKey: string, permMap: Map<string, boolean>): boolean {
  return isAllowed(role, moduleKey, permMap);
}

/** Check access to a full page/route (e.g. "page_dashboard") */
export function canAccessPage(role: string, pageKey: string, permMap: Map<string, boolean>): boolean {
  return isAllowed(role, pageKey, permMap);
}

/** Check visibility of a sub-section / tab (e.g. "tab_workers_payroll") */
export function canAccessTab(role: string, tabKey: string, permMap: Map<string, boolean>): boolean {
  return isAllowed(role, tabKey, permMap);
}

/** Check permission to perform a write/action (e.g. "act_create_voucher") */
export function canPerformAction(role: string, actionKey: string, permMap: Map<string, boolean>): boolean {
  return isAllowed(role, actionKey, permMap);
}

/** Check visibility of a sensitive data field (e.g. "fld_cost_price") */
export function canSeeSensitiveField(role: string, fieldKey: string, permMap: Map<string, boolean>): boolean {
  return isAllowed(role, fieldKey, permMap);
}

/** Check export/print capabilities (e.g. "exp_pdf") */
export function canUseExportPrint(role: string, exportKey: string, permMap: Map<string, boolean>): boolean {
  return isAllowed(role, exportKey, permMap);
}

/**
 * Convenience: check any permission key regardless of its type prefix.
 * Delegates to isAllowed with the same logic.
 */
export function canAccess(role: string, permissionKey: string, permMap: Map<string, boolean>): boolean {
  return isAllowed(role, permissionKey, permMap);
}
