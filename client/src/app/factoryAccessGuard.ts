/**
 * Factory access guard — pure helpers, no React, no hooks.
 *
 * Exports:
 *   SUBPAGE_PARENT           – sub-page → parent pageKey mapping table
 *   computeFactoryDefaultPage – first accessible landing page for a user
 *   resolvePageKey            – maps a URL path to its pageKey
 *   computeFactoryGuardRedirect – evaluates all guard conditions, returns redirect or null
 */

import { FACTORY_NAV_SECTIONS, FACTORY_NAV_PAGES } from "@/components/FactorySidebar";

export interface MyAccess {
  fullAccess: boolean;
  pageKeys: string[];
  hasErpAccess: boolean;
  hasFactoryAccess: boolean;
  companyId?: number;
  companyName?: string;
  hiddenCostFields?: string[];
}

/**
 * Sub-page → parent pageKey for detail/action routes that are not direct
 * nav items but should inherit their parent's access requirement.
 * Also used by computeFactoryDefaultPage to accept old pre-merge page keys
 * for hub pages.
 */
export const SUBPAGE_PARENT: [prefix: string, parentKey: string][] = [
  ["/factory/sales/invoices", "factory/invoicing"],
  ["/factory/sales/new", "factory/invoicing"],
  ["/factory/sales/pending-invoices", "factory/invoicing"],
  ["/factory/invoices", "factory/invoicing"],
  ["/factory/sales/loading/", "factory/sales/loadings"],
  ["/factory/bale-product-history", "factory/bales-hub"],
  ["/factory/reprint-labels", "factory/bales-hub"],
  ["/factory/bales-history", "factory/bales-hub"],
  ["/factory/barcode-lookup", "factory/bales-hub"],
  ["/factory/payroll", "factory/payroll-hub"],
  ["/factory/worker-payroll", "factory/payroll-hub"],
  ["/factory/workers", "factory/payroll-hub"],
  ["/factory/employees", "factory/payroll-hub"],
  ["/factory/containers/new", "factory/containers-hub"],
  ["/factory/containers", "factory/containers-hub"],
  ["/factory/stock-otw", "factory/containers-hub"],
  ["/factory/customers", "factory/parties"],
  ["/factory/suppliers", "factory/parties"],
  ["/factory/net-position-details", "factory/intelligence/financial-hub"],
  ["/factory/net-position", "factory/intelligence/financial-hub"],
  ["/factory/net-profit-analytics", "factory/intelligence/financial-hub"],
  ["/factory/supplier-report", "factory/intelligence/supplier-hub"],
  ["/factory/supplier-statement", "factory/intelligence/supplier-hub"],
  ["/factory/production-summary", "factory/intelligence/production-hub"],
  ["/factory/ledger-monthly", "factory/accounts"],
  ["/factory/ledger-vouchers", "factory/accounts"],
  ["/factory/voucher-detail", "factory/vouchers"],
  ["/factory/create", "factory/accounts"],
  ["/factory/financial-snapshot", "factory/analytics"],
];

/**
 * Compute the right landing page for this factory user.
 * For restricted users (fullAccess:false) walks the complete manageable Factory
 * page registry and returns the first accessible page. Falls back to My Settings
 * when the stored allow-list contains only stale/unknown keys.
 */
export function computeFactoryDefaultPage(myAccess: MyAccess | undefined): string {
  if (!myAccess || myAccess.fullAccess) return "/factory/production-report";

  const nonLandingKeys = new Set(["factory/settings", "factory/intelligence/settings"]);
  for (const page of FACTORY_NAV_PAGES) {
    if (nonLandingKeys.has(page.key)) continue;
    const url = "/" + page.key;
    if (myAccess.pageKeys.includes(page.key)) return url;

    // Accept old pre-hub-merge keys that now resolve to this canonical page.
    const legacyKeys = SUBPAGE_PARENT.filter(([, parentKey]) => parentKey === page.key).map(([prefix]) =>
      prefix.replace(/^\//, "")
    );
    if (legacyKeys.some((key) => myAccess.pageKeys.includes(key))) return url;
  }

  // A stale/unknown allow-list must never loop back into a denied Factory page.
  return "/my-settings";
}

/**
 * Resolve the pageKey for the given path.
 * Uses FACTORY_NAV_PAGES as the canonical list so sidebar, pinned, and
 * explicitly registered Factory pages are all guarded consistently.
 */
export function resolvePageKey(path: string): string | null {
  // 1. Direct match against every known page (exact or sub-path)
  for (const page of FACTORY_NAV_PAGES) {
    const url = "/" + page.key;
    if (path === url || path.startsWith(url + "/")) return page.key;
  }
  // 2. Sub-page map for detail routes that aren't direct nav entries
  for (const [prefix, parentKey] of SUBPAGE_PARENT) {
    if (path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix)) return parentKey;
  }
  return null;
}

/**
 * Evaluate all factory route-level access guard conditions.
 * Returns a redirect path if the user should be redirected, or null if allowed.
 *
 * Covers:
 *   1. Per-user page restriction (pageKeys allow-list + legacy key support)
 *   2. Feature-flag restriction (factory settings toggles)
 *   3. hiddenCostFields tab restriction (production analytics)
 */
export function computeFactoryGuardRedirect(params: {
  isFactoryRoute: boolean;
  isAdminOwner: boolean;
  myAccess: MyAccess | undefined;
  factorySettings: Record<string, unknown> | undefined;
  factoryDefaultPage: string;
  currentLocation: string;
}): string | null {
  const { isFactoryRoute, isAdminOwner, myAccess, factorySettings, factoryDefaultPage, currentLocation } = params;

  if (!isFactoryRoute || isAdminOwner || myAccess === undefined) return null;

  const isRestrictedUser = !myAccess.fullAccess;
  const requiredKey = resolvePageKey(currentLocation);
  const VIEWABLE_BY_ALL = new Set(["factory/sheets-sacks"]);

  // 1. Per-user page restriction
  if (isRestrictedUser && requiredKey && !VIEWABLE_BY_ALL.has(requiredKey)) {
    const hasDirectAccess = myAccess.pageKeys.includes(requiredKey);
    const hasLegacyAccess = SUBPAGE_PARENT.filter(([, parentKey]) => parentKey === requiredKey).some(([prefix]) =>
      myAccess.pageKeys.includes(prefix.replace(/^\//, ""))
    );
    if (!hasDirectAccess && !hasLegacyAccess) return factoryDefaultPage;
  }

  // 2. Feature-flag restriction
  if (factorySettings && requiredKey) {
    for (const section of FACTORY_NAV_SECTIONS) {
      for (const item of section.items) {
        const itemKey = item.url.replace(/^\//, "");
        if (itemKey === requiredKey && item.featureFlag) {
          const flag = item.featureFlag as string;
          const defaultOn = !!item.featureFlagDefaultOn;
          const enabled = defaultOn ? factorySettings[flag] !== false : factorySettings[flag] === true;
          if (!enabled) return factoryDefaultPage;
        }
      }
    }
  }

  // 3. hiddenCostFields tab restriction
  if (
    currentLocation === "/factory/production-report" &&
    myAccess.hiddenCostFields?.includes("hide_tab_production_analytics")
  ) {
    return factoryDefaultPage;
  }

  return null;
}
