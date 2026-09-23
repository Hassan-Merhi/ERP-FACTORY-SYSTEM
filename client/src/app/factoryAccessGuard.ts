/**
 * Factory access guard — pure helpers, no React, no hooks.
 *
 * All page resolution comes from factoryAccessRegistry so Settings, sidebar
 * navigation and direct-route protection share the same source of truth.
 */

import {
  FACTORY_LANDING_PAGES,
  FACTORY_SUBPAGE_PARENT,
  factoryPageAllowsRole,
  hasFactoryPageKey,
  resolveFactoryPage,
  resolveFactoryPageKey,
} from "@/app/factoryAccessRegistry";

export interface MyAccess {
  fullAccess: boolean;
  pageKeys: string[];
  hasErpAccess: boolean;
  hasFactoryAccess: boolean;
  companyId?: number;
  companyName?: string;
  hiddenCostFields?: string[];
}

// Compatibility export for existing callers/tests. The data is now generated
// from the canonical page registry instead of maintained independently.
export const SUBPAGE_PARENT: [prefix: string, parentKey: string][] = [...FACTORY_SUBPAGE_PARENT];

/**
 * Compute the first usable Factory landing page.
 * Legacy pre-hub page keys remain accepted through each registry entry's aliases.
 */
export function computeFactoryDefaultPage(myAccess: MyAccess | undefined, userRole?: string | null): string {
  if (!myAccess || myAccess.fullAccess) return "/factory/production-report";

  for (const page of FACTORY_LANDING_PAGES) {
    if (userRole && !factoryPageAllowsRole(page, userRole)) continue;
    if (hasFactoryPageKey(page, myAccess.pageKeys)) return page.route;
  }

  // A stale/unknown allow-list must never loop back into a denied Factory page.
  return "/my-settings";
}

/** Resolve a Factory URL to its canonical per-user page-access key. */
export function resolvePageKey(path: string): string | null {
  return resolveFactoryPageKey(path);
}

/**
 * Evaluate Factory route-level access conditions.
 *
 * Order matters:
 * 1. role classification from the registry
 * 2. feature flag visibility from the registry
 * 3. privileged role bypass of per-user allow-lists
 * 4. per-user page allow-list
 * 5. legacy page hide keys
 */
export function computeFactoryGuardRedirect(params: {
  isFactoryRoute: boolean;
  isAdminOwner: boolean;
  userRole?: string | null;
  myAccess: MyAccess | undefined;
  factorySettings: Record<string, unknown> | undefined;
  factoryDefaultPage: string;
  currentLocation: string;
}): string | null {
  const {
    isFactoryRoute,
    isAdminOwner,
    userRole,
    myAccess,
    factorySettings,
    factoryDefaultPage,
    currentLocation,
  } = params;

  if (!isFactoryRoute || myAccess === undefined) return null;

  const page = resolveFactoryPage(currentLocation);

  // Protected system routes are classified in the same registry used by the
  // sidebar. When role context is supplied, direct URLs cannot bypass it.
  if (page && userRole && !factoryPageAllowsRole(page, userRole)) {
    return factoryDefaultPage;
  }

  if (page?.featureFlag && factorySettings) {
    const defaultOn = !!page.featureFlagDefaultOn;
    const enabled = defaultOn
      ? factorySettings[page.featureFlag] !== false
      : factorySettings[page.featureFlag] === true;
    if (!enabled) return factoryDefaultPage;
  }

  // Admin/Owner/Developer keep their established page allow-list bypass after
  // role classification and feature-flag checks.
  if (isAdminOwner) return null;

  // Restricted Factory users are default-deny. Every current Factory route is
  // represented in the registry; an unknown future route cannot bypass an
  // existing allow-list.
  if (!myAccess.fullAccess) {
    if (!page) return factoryDefaultPage;
    if (!hasFactoryPageKey(page, myAccess.pageKeys)) return factoryDefaultPage;
  }

  return null;
}
