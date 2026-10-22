import { FEATURE_KEYS } from "./schema";

/**
 * The sandbox tester can use ERP operational screens, but not Factory or the
 * administrative Settings screen. The company is standalone and empty, so this
 * access policy cannot alter the role permissions of an existing company.
 */
export const ERP_TESTER_PAGE_KEYS = FEATURE_KEYS.filter((key) => key !== "settings" && key !== "factory_production");

export const ERP_TESTER_ROLE_PERMISSIONS = [
  { featureKey: "mod_erp", enabled: true },
  { featureKey: "mod_factory", enabled: false },
  { featureKey: "mod_properties", enabled: false },
  { featureKey: "mod_settings", enabled: false },
  { featureKey: "page_settings", enabled: false },
] as const;
