/**
 * Which ERP page grants open a given ERP route. Shared by the client sidebar
 * and route guards and by the server (training video access), so both apply
 * the same rule.
 */
import { ROUTE_TO_FEATURE, type FeatureKey } from "./schema";

export const ERP_COMPOSITE_ROUTE_FEATURES: Record<string, readonly FeatureKey[]> = {
  "/financial-overview": ["dashboard"],
  "/cost-centers": ["accounts"],
  "/inventory": ["location_inventory", "stock_otw", "containers"],
  "/stock": ["stock_items", "stock_query", "stock_otw"],
  "/parties": ["suppliers", "customers"],
  "/transaction-journal": ["daybook"],
  "/stock-in-sales-report": ["sales_report"],
  "/item-market-analysis": ["sales_report"],
  "/pos-item-replacement": ["pos"],
  "/supplier-profit-check": ["suppliers"],
  "/supplier-profit-reconciliation": ["sales_report"],
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

/** ERP pages the sidebar shows to Developers only (see AppSidebar isItemVisible). */
const ERP_DEVELOPER_ONLY_ROUTES = new Set([
  "/cost-centers",
  "/net-profit-report",
  "/company-transfer",
  "/spreadsheet",
  "/live-sheets",
  "/chat",
]);

export function isErpDeveloperOnlyRoute(url: string): boolean {
  const path = canonicalErpAccessPath(url);
  return ERP_DEVELOPER_ONLY_ROUTES.has(path) || path.startsWith("/accounting/");
}

/** The only ERP pages a POS user's sidebar offers (POS Excel import aside). */
export const ERP_POS_ROLE_ROUTES: readonly string[] = [
  "/pos",
  "/pos-dashboard",
  "/pos-daybook",
  "/sales-tools",
  "/location-inventory",
];
