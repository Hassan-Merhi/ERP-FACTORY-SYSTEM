import { computeFactoryDefaultPage, computeFactoryGuardRedirect } from "./factoryAccessGuard";
import type { FactoryAccess } from "./useAuthenticatedAppData";

const SUPPLIER_PARTNER_PATHS = new Set([
  "/sp",
  "/sp/golden-coast",
  "/sp/reports",
  "/sp/opening-stock",
  "/sp/aliases",
  "/sp/setup",
  "/sp/migration",
  "/sp/gc-migration",
]);

const RETAIL_INVENTORY_ALIASES = new Set(["/inventory", "/stock", "/location-inventory", "/stock-items"]);

export type AuthenticatedAppRouteDecision =
  { kind: "continue" } | { kind: "loading" } | { kind: "bootstrap-error" } | { kind: "redirect"; to: string };

interface ResolveAuthenticatedAppRouteOptions {
  currentLocation: string;
  companyType?: string | null;
  isAdminOwner: boolean;
  userRole?: string | null;
  myAccess?: FactoryAccess;
  myAccessLoading: boolean;
  myAccessError: boolean;
  factorySettings?: Record<string, unknown>;
}

export function resolveAuthenticatedAppRoute({
  currentLocation,
  companyType,
  isAdminOwner,
  userRole,
  myAccess,
  myAccessLoading,
  myAccessError,
  factorySettings,
}: ResolveAuthenticatedAppRouteOptions) {
  const isPropertiesCompany = companyType === "properties";
  const isPropertiesRoute = currentLocation.startsWith("/properties/");
  const isSupplierPartnerCompany = companyType === "supplier_partner";
  const isSupplierPartnerRoute = currentLocation === "/sp" || currentLocation.startsWith("/sp/");
  const isRetailCompany = companyType === "retail";
  const isRetailRoute = currentLocation === "/retail" || currentLocation.startsWith("/retail/");
  const isFactoryCompany = companyType === "factory" || companyType === "factory_v2";
  const isFactoryRoute = currentLocation.startsWith("/factory/");
  const hasErpAccess = !isFactoryCompany || !myAccess || myAccess.hasErpAccess;
  const hasFactoryAccess = isFactoryCompany && (!myAccess || myAccess.hasFactoryAccess);
  const factoryDefaultPage = computeFactoryDefaultPage(myAccess, userRole);
  const isFactoryBootstrapExemptRoute =
    currentLocation === "/my-settings" || currentLocation === "/intercompany-requests";
  const isFactoryBootstrapRoute = isFactoryCompany && (isFactoryRoute || !isFactoryBootstrapExemptRoute);

  let decision: AuthenticatedAppRouteDecision = { kind: "continue" };

  if (isPropertiesCompany && currentLocation === "/my-settings") {
    decision = { kind: "redirect", to: "/properties/my-settings" };
  } else if (isPropertiesCompany && currentLocation === "/balance-repair") {
    decision = { kind: "redirect", to: "/properties/balance-repair" };
  } else if (isPropertiesCompany && !isPropertiesRoute) {
    decision = { kind: "redirect", to: "/properties/daybook" };
  } else if (isPropertiesRoute && !isPropertiesCompany) {
    decision = { kind: "redirect", to: "/" };
  } else if (isSupplierPartnerRoute && !isSupplierPartnerCompany) {
    decision = { kind: "redirect", to: "/tracking" };
  } else if (
    isSupplierPartnerCompany &&
    (currentLocation === "/sp/migration" || currentLocation === "/sp/gc-migration")
  ) {
    decision = { kind: "redirect", to: "/sp/setup" };
  } else if (isSupplierPartnerCompany && isSupplierPartnerRoute && !SUPPLIER_PARTNER_PATHS.has(currentLocation)) {
    decision = { kind: "redirect", to: "/sp" };
  } else if (isRetailRoute && !isRetailCompany) {
    decision = { kind: "redirect", to: "/tracking" };
  } else if (isRetailCompany && (currentLocation === "/" || currentLocation === "/retail/dashboard")) {
    // Retail is still a normal ERP company. Its landing page is the standard ERP dashboard.
    decision = { kind: "redirect", to: "/financial-overview" };
  } else if (isRetailCompany && currentLocation === "/pos") {
    // Retail uses the variant-aware POS rather than the legacy stock-item POS.
    decision = { kind: "redirect", to: "/retail/pos" };
  } else if (isRetailCompany && RETAIL_INVENTORY_ALIASES.has(currentLocation)) {
    // Only inventory is specialized; accounting, vouchers, parties, daybook, etc. stay on normal ERP routes.
    decision = { kind: "redirect", to: "/retail/inventory" };
  } else if (isFactoryRoute && !isFactoryCompany) {
    decision = { kind: "redirect", to: "/" };
  } else if (isFactoryBootstrapRoute && myAccessLoading && myAccess === undefined) {
    decision = { kind: "loading" };
  } else if (isFactoryBootstrapRoute && myAccess === undefined && !myAccessError) {
    decision = { kind: "loading" };
  } else if (isFactoryBootstrapRoute && myAccess === undefined && myAccessError) {
    decision = { kind: "bootstrap-error" };
  } else if (
    isFactoryCompany &&
    !isFactoryRoute &&
    currentLocation !== "/my-settings" &&
    currentLocation !== "/intercompany-requests"
  ) {
    decision = { kind: "redirect", to: factoryDefaultPage };
  } else if (isFactoryRoute && !hasFactoryAccess) {
    decision = { kind: "redirect", to: "/" };
  } else {
    const factoryGuardRedirect = computeFactoryGuardRedirect({
      isFactoryRoute,
      isAdminOwner,
      userRole,
      myAccess,
      factorySettings,
      factoryDefaultPage,
      currentLocation,
    });
    if (factoryGuardRedirect) {
      decision = { kind: "redirect", to: factoryGuardRedirect };
    }
  }

  return {
    decision,
    isPropertiesCompany,
    isPropertiesRoute,
    isRetailCompany,
    isRetailRoute,
    isFactoryCompany,
    isFactoryRoute,
    hasErpAccess,
    factoryDefaultPage,
  };
}
