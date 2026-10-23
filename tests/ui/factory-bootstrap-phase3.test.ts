import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAuthenticatedAppRoute } from "@/app/authenticatedAppRouteGuard";

const baseGuardInput = {
  isAdminOwner: false,
  myAccessLoading: false,
  myAccessError: false,
};

const fullFactoryAccess = {
  fullAccess: true,
  pageKeys: [],
  hasErpAccess: true,
  hasFactoryAccess: true,
};

describe("Phase 3 factory bootstrap isolation", () => {
  it("blocks Settings for ERP Tester across all company types without blocking regular operations", () => {
    const cases = [
      { companyType: "erp", settings: "/settings", normal: "/tracking", fallback: "/tracking" },
      { companyType: "retail", settings: "/my-settings", normal: "/retail/pos", fallback: "/tracking" },
      {
        companyType: "factory",
        settings: "/factory/intelligence/settings",
        normal: "/factory/production-report",
        fallback: "/factory/production-report",
      },
      {
        companyType: "properties",
        settings: "/properties/my-settings",
        normal: "/properties/daybook",
        fallback: "/properties/daybook",
      },
      { companyType: "supplier_partner", settings: "/sp/setup", normal: "/sp", fallback: "/sp" },
    ] as const;

    for (const item of cases) {
      const forbidden = resolveAuthenticatedAppRoute({
        ...baseGuardInput,
        currentLocation: item.settings,
        companyType: item.companyType,
        userRole: "ERP Tester",
        myAccess: fullFactoryAccess,
      });
      expect(forbidden.decision).toEqual({ kind: "redirect", to: item.fallback });

      const allowed = resolveAuthenticatedAppRoute({
        ...baseGuardInput,
        currentLocation: item.normal,
        companyType: item.companyType,
        userRole: "ERP Tester",
        myAccess: fullFactoryAccess,
      });
      expect(allowed.decision).toEqual({ kind: "continue" });
    }
  });

  it("keeps Factory and Properties personal Settings hidden in the navigation and route tree", () => {
    const factoryNav = readFileSync("client/src/components/FactorySidebar.tsx", "utf8");
    const factoryRoutes = readFileSync("client/src/components/FactoryRoutes.tsx", "utf8");
    const propertiesNav = readFileSync("client/src/components/PropertiesSidebar.tsx", "utf8");
    const propertiesRoutes = readFileSync("client/src/app/PropertiesRoutes.tsx", "utf8");
    expect(factoryNav).toContain('"Developer", "ERP Tester"');
    expect(factoryRoutes).toContain('user?.role !== "ERP Tester" && <Route path="/my-settings"');
    expect(propertiesNav).toContain('user?.role !== "ERP Tester"');
    expect(propertiesRoutes).toContain('user.role !== "ERP Tester" && <Route path="/properties/my-settings"');
  });

  it("does not let Factory access loading gate a normal ERP company", () => {
    const result = resolveAuthenticatedAppRoute({
      ...baseGuardInput,
      currentLocation: "/tracking",
      companyType: "erp",
      myAccessLoading: true,
    });

    expect(result.decision).toEqual({ kind: "continue" });
    expect(result.hasErpAccess).toBe(true);
  });

  it("ignores stale Factory-only access data for a normal ERP company", () => {
    const result = resolveAuthenticatedAppRoute({
      ...baseGuardInput,
      currentLocation: "/tracking",
      companyType: "erp",
      myAccess: {
        fullAccess: false,
        pageKeys: [],
        hasErpAccess: false,
        hasFactoryAccess: true,
      },
    });

    expect(result.decision).toEqual({ kind: "continue" });
    expect(result.hasErpAccess).toBe(true);
  });

  it("keeps a Factory route loading while access is still being resolved", () => {
    const loading = resolveAuthenticatedAppRoute({
      ...baseGuardInput,
      currentLocation: "/factory/production-report",
      companyType: "factory",
      myAccessLoading: true,
    });
    const noDataYet = resolveAuthenticatedAppRoute({
      ...baseGuardInput,
      currentLocation: "/factory/production-report",
      companyType: "factory",
    });

    expect(loading.decision).toEqual({ kind: "loading" });
    expect(noDataYet.decision).toEqual({ kind: "loading" });
  });

  it("surfaces recovery only after Factory access retries have ended in error", () => {
    const result = resolveAuthenticatedAppRoute({
      ...baseGuardInput,
      currentLocation: "/factory/production-report",
      companyType: "factory",
      myAccessError: true,
    });

    expect(result.decision).toEqual({ kind: "bootstrap-error" });
  });

  it("keeps cached Factory access usable when a background refetch fails", () => {
    const result = resolveAuthenticatedAppRoute({
      ...baseGuardInput,
      currentLocation: "/factory/production-report",
      companyType: "factory",
      myAccess: fullFactoryAccess,
      myAccessError: true,
    });

    expect(result.decision).toEqual({ kind: "continue" });
  });

  it("continues into Factory after valid access is loaded", () => {
    const result = resolveAuthenticatedAppRoute({
      ...baseGuardInput,
      currentLocation: "/factory/production-report",
      companyType: "factory",
      myAccess: fullFactoryAccess,
    });

    expect(result.decision).toEqual({ kind: "continue" });
  });

  it("rejects a stale Factory URL for a non-Factory company without waiting for Factory data", () => {
    const result = resolveAuthenticatedAppRoute({
      ...baseGuardInput,
      currentLocation: "/factory/production-report",
      companyType: "erp",
      myAccessLoading: true,
    });

    expect(result.decision).toEqual({ kind: "redirect", to: "/" });
  });

  it("only enables Factory bootstrap queries for Factory companies", () => {
    const hook = readFileSync("client/src/app/useAuthenticatedAppData.ts", "utf8");
    const app = readFileSync("client/src/app/AuthenticatedApp.tsx", "utf8");
    const loadingState = readFileSync("client/src/app/AppLoadingState.tsx", "utf8");

    expect(hook).toContain('const isFactoryCompany = companyType === "factory" || companyType === "factory_v2";');
    expect(hook).toContain(
      "const factoryBootstrapEnabled = userPresent && !isPOS && !!selectedCompanyId && isFactoryCompany;"
    );
    expect(hook.match(/enabled: factoryBootstrapEnabled/g)).toHaveLength(3);
    expect(app).toContain("companyType: selectedCompany?.companyType");
    expect(app).toContain('routeState.decision.kind === "bootstrap-error"');
    expect(loadingState).toContain("showRecovery");
    expect(loadingState).toContain('secondaryActionLabel="Go to sign in"');
  });
});
