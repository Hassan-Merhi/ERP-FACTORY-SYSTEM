import type { FeatureKey } from "@shared/schema";

export interface ErpFeatureAccess {
  fullAccess: boolean;
  pageKeys: string[];
}

export { ERP_COMPOSITE_ROUTE_FEATURES, canonicalErpAccessPath, getErpRouteFeatureKeys } from "@shared/erpRouteAccess";

export function canAccessErpFeature(access: ErpFeatureAccess | undefined, key: FeatureKey): boolean {
  return !access || access.fullAccess || access.pageKeys.includes(key);
}

export function canAccessAnyErpFeature(access: ErpFeatureAccess | undefined, keys: readonly FeatureKey[]): boolean {
  return keys.some((key) => canAccessErpFeature(access, key));
}
