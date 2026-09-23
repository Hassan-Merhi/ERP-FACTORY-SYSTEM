import { ROUTE_TO_FEATURE, type FeatureKey } from "@shared/schema";

export interface ErpFeatureAccess {
  fullAccess: boolean;
  pageKeys: string[];
}

export const ERP_COMPOSITE_ROUTE_FEATURES: Record<string, readonly FeatureKey[]> = {
  "/financial-overview": ["dashboard"],
  "/inventory": ["location_inventory", "stock_otw", "containers"],
  "/stock": ["stock_items", "stock_query"],
  "/parties": ["suppliers", "customers"],
  "/transaction-journal": ["daybook"],
  "/stock-in-sales-report": ["sales_report"],
  "/pos-item-replacement": ["pos"],
  "/supplier-profit-check": ["suppliers"],
};

export function canonicalErpAccessPath(url: string): string {
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  const cutAt = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const path = cutAt === undefined ? url : url.slice(0, cutAt);
  return path || "/";
}

export function getErpRouteFeatureKeys(url: string): readonly FeatureKey[] {
  const path = canonicalErpAccessPath(url);
  const composite = ERP_COMPOSITE_ROUTE_FEATURES[path];
  if (composite) return composite;
  const direct = ROUTE_TO_FEATURE[path];
  return direct ? [direct] : [];
}

export function canAccessErpFeature(access: ErpFeatureAccess | undefined, key: FeatureKey): boolean {
  return !access || access.fullAccess || access.pageKeys.includes(key);
}

export function canAccessAnyErpFeature(
  access: ErpFeatureAccess | undefined,
  keys: readonly FeatureKey[],
): boolean {
  return keys.some((key) => canAccessErpFeature(access, key));
}
