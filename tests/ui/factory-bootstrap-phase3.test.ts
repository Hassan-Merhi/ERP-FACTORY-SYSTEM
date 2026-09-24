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
