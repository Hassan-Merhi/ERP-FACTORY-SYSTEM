/**
 * Commercial API allow-list, intentionally smaller than the operational ERP.
 * Unknown and privileged endpoints must be audited before being admitted.
 *
 * This table is synchronized with subscriptionPolicy.mjs in a contract test.
 */
export const commercialModulesByPlan = {
  retail: ["retail", "pos", "inventory", "reports"],
  business: ["erp", "pos", "inventory", "accounting", "purchasing", "reports"],
  factory: ["erp", "factory", "inventory", "accounting", "dispatch", "reports"],
  enterprise: [
    "erp", "pos", "retail", "inventory", "accounting", "purchasing",
    "factory", "dispatch", "logistics", "reports", "multi_company",
  ],
} as const;

type CommercialPlan = keyof typeof commercialModulesByPlan;

const featureRoutes: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/api\/(stock|inventory|locations)(?:\/|$|-)/, "inventory"],
  [/^\/api\/(pos|retail)(?:\/|$|-)/, "pos"],
  [/^\/api\/factory\/(?:dispatch|invoice-loading)(?:\/|$)/, "dispatch"],
  [/^\/api\/factory(?:\/|$)/, "factory"],
  [/^\/api\/(accounts|ledger|vouchers|daybook)(?:\/|$|-)/, "accounting"],
  [/^\/api\/(purchase-orders|purchase)(?:\/|$|-)/, "purchasing"],
  [/^\/api\/(containers|container-tracking)(?:\/|$|-)/, "logistics"],
  [/^\/api\/(customers|suppliers)(?:\/|$|-)/, "erp"],
  [/^\/api\/(reports|analytics|stats)(?:\/|$|-)/, "reports"],
];

const accountPaths = new Set([
  "/api/user/companies",
  "/api/auth/session-company",
  "/api/auth/set-company",
  "/api/auth/change-password",
]);

export function classifyCommercialRoute(path: string): string | null {
  if (accountPaths.has(path)) return "account";
  const match = featureRoutes.find(([pattern]) => pattern.test(path));
  return match?.[1] ?? null;
}

export function commercialRouteEntitlement(
  plan: string | null,
  path: string,
): { allowed: boolean; reason: string; module?: string } {
  if (!plan || !Object.hasOwn(commercialModulesByPlan, plan)) {
    return { allowed: false, reason: "plan_unknown" };
  }
  const feature = classifyCommercialRoute(path);
  if (!feature) return { allowed: false, reason: "route_not_certified" };
  if (feature === "account") return { allowed: true, reason: "account_access", module: feature };
  const modules = commercialModulesByPlan[plan as CommercialPlan] as readonly string[];
  if (!modules.includes(feature)) {
    return { allowed: false, reason: "plan_feature_denied", module: feature };
  }
  return { allowed: true, reason: "entitled", module: feature };
}
