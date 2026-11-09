/**
 * ERP navigation and route ROLE restrictions.
 *
 * This is the UI-side catalog used by routes, desktop sidebar, phone menus and
 * command search. It never grants API permissions; backend authorization is
 * authoritative. Feature-page grants are still evaluated separately.
 */
import { isExistingRecordReadOnlyRole } from "./createOnlyRolePolicy";
import { canonicalErpAccessPath, getErpRouteFeatureKeys, ERP_POS_ROLE_ROUTES, isErpDeveloperOnlyRoute } from "./erpRouteAccess";

export interface ErpNavigationUser {
  role?: string | null;
  currentRole?: string | null;
}

export interface ErpNavigationAccess {
  fullAccess: boolean;
  pageKeys: readonly string[];
}

export interface ErpNavigationContext {
  role: string | null | undefined;
  path: string;
  companyType?: string | null;
  access?: ErpNavigationAccess;
  posExcelImportEnabled?: boolean;
}

/** These ERP routes are restricted in ErpRoutes, not just hidden in menus. */
export const ERP_ADMIN_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/settings",
  "/intercompany-links",
  "/orphaned-records",
  "/deleted-items",
  "/chatbot-settings",
  "/notification-settings",
  "/account-groups",
  "/import-cycle-diagnostics",
  "/inventory-repair",
  "/balance-repair",
  "/net-position-details",
  "/company-data-reset",
  "/account-migration",
  "/account-transfer",
  "/mock-containers-otw",
  "/containers-otw",
  "/mock-git",
  "/git",
]);

export const ERP_ADMIN_OWNER_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "/convergence-reconciliation",
  "/accounts/historical-openings",
]);

export const ERP_DEVELOPER_ADDITIONAL_ROUTES: ReadonlySet<string> = new Set([
  "/ai-validation",
  "/ai-command-center",
]);

export const ERP_RETAIL_HIDDEN_ROUTES: ReadonlySet<string> = new Set([
  "/tracking",
  "/agents",
  "/transaction-journal",
  "/stock-transfer-order",
  "/optional-vouchers",
  "/stock",
  "/supplier-profit-check",
  "/pos-item-replacement",
  "/sales-tools",
  "/stock-in-sales-report",
  "/supplier-profit-reconciliation",
  "/erp/rental/shops",
  "/ai-command-center",
  "/ai-validation",
]);

export const ERP_PERSONAL_SETTINGS_HIDDEN_ROLES: ReadonlySet<string> = new Set([
  "Admin",
  "Developer",
  "ERP Tester",
]);

export function effectiveErpRole(user: ErpNavigationUser | undefined): string {
  return user?.currentRole ?? user?.role ?? "";
}

export function isErpRetailHiddenPath(url: string): boolean {
  return ERP_RETAIL_HIDDEN_ROUTES.has(canonicalErpAccessPath(url));
}

export function isErpRouteRoleAllowed(url: string, role: string | null | undefined): boolean {
  const path = canonicalErpAccessPath(url);
  const isDeveloper = role === "Developer";
  const isAdmin = role === "Admin";
  const isOwner = role === "Owner";

  if (isErpDeveloperOnlyRoute(path) || ERP_DEVELOPER_ADDITIONAL_ROUTES.has(path)) return isDeveloper;
  if (ERP_ADMIN_ONLY_ROUTES.has(path)) return isDeveloper || isAdmin;
  if (ERP_ADMIN_OWNER_ONLY_ROUTES.has(path)) return isDeveloper || isAdmin || isOwner;
  if (path === "/financial-overview" && isExistingRecordReadOnlyRole(role)) return false;
  if (path === "/transaction-journal" && role === "ERP Tester") return false;
  if (path === "/my-settings" && role === "ERP Tester") return false;
  if (path === "/pos-item-replacement" && role === "POS") return false;
  return true;
}

/** Presentation visibility; this is never a substitute for server checks. */
export function isErpNavigationItemVisible({
  role,
  path: url,
  companyType,
  access,
  posExcelImportEnabled = false,
}: ErpNavigationContext): boolean {
  const path = canonicalErpAccessPath(url);
  const isPOS = role === "POS";
  const isDeveloper = role === "Developer";
  const isAdmin = role === "Admin";

  if (!isErpRouteRoleAllowed(path, role)) return false;
  if (companyType === "retail" && isErpRetailHiddenPath(path)) return false;
  if (path === "/tracking") return !isPOS;
  if (path === "/factory/raw-stock" && companyType !== "factory" && companyType !== "factory_v2") return false;
  if (path === "/item-market-analysis" && companyType !== "erp") return false;

  // POS menus intentionally expose only a small curated subset, including
  // Excel import when company settings permit it; retain legacy behavior.
  if (isPOS) {
    return ERP_POS_ROLE_ROUTES.includes(path) || (path === "/pos-import" && posExcelImportEnabled);
  }
  if (isDeveloper || isAdmin || access?.fullAccess) return true;

  const features = getErpRouteFeatureKeys(path);
  if (features.length > 0 && access) {
    return features.some((key) => access.pageKeys.includes(key));
  }
  if (access && access.pageKeys.length === 0) return false;
  return true;
}
