import { FEATURE_KEYS } from "./schema";

/**
 * The sandbox tester can use ERP operational screens, but not Factory or the
 * administrative Settings screen. The company is standalone and empty, so this
 * access policy cannot alter the role permissions of an existing company.
 */
export const ERP_TESTER_ROLE = "ERP Tester" as const;

export const isErpTestCompanyCode = (code: string | null | undefined): boolean =>
  typeof code === "string" && /^ERPTEST-[A-F0-9]{10}$/.test(code);

const ERP_TESTER_FORBIDDEN_API_PREFIXES = [
  "/api/settings",
  "/api/my-settings",
  "/api/admin",
  "/api/users",
  "/api/user-company-roles",
  "/api/role-permissions",
  "/api/company-settings",
  "/api/factory",
  "/api/properties",
  "/api/sp",
  "/api/companies/erp-test",
] as const;

export const isErpTesterForbiddenApiPath = (urlPath: string): boolean => {
  const path = urlPath.toLowerCase();
  if (/(^|\/)(settings|configuration)(\/|$)/.test(path)) return true;
  return ERP_TESTER_FORBIDDEN_API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
};

export const ERP_TESTER_PAGE_KEYS = FEATURE_KEYS.filter((key) => key !== "settings" && key !== "factory_production");

export const ERP_TESTER_ROLE_PERMISSIONS = [
  { featureKey: "mod_erp", enabled: true },
  { featureKey: "mod_factory", enabled: false },
  { featureKey: "mod_properties", enabled: false },
  { featureKey: "mod_settings", enabled: false },
  { featureKey: "page_settings", enabled: false },
] as const;
