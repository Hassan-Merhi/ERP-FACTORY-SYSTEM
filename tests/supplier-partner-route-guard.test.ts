import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const authenticatedApp = readFileSync("client/src/app/AuthenticatedApp.tsx", "utf8");
const routeGuard = readFileSync("client/src/app/authenticatedAppRouteGuard.ts", "utf8");
const erpRoutes = readFileSync("client/src/routes/ErpRoutes.tsx", "utf8");

describe("Supplier Partner route boundary", () => {
  it("classifies both /sp and /sp child routes", () => {
    expect(routeGuard).toContain('currentLocation === "/sp" || currentLocation.startsWith("/sp/")');
  });

  it("waits for company initialization before rejecting Supplier Partner routes", () => {
    // Authentication is resolved before this shell mounts. Company loading is
    // still awaited before any route decision is resolved, so Supplier Partner
    // routes are never rejected mid-restoration.
    expect(authenticatedApp).toContain("const { selectedCompany, isLoading: companyLoading, isCheckingCompanySession } = useCompany()");
    expect(authenticatedApp).toContain("if (!selectedCompany || (companyLoading && !isCheckingCompanySession)) return <AppLoadingState />");
    const companyGuard = authenticatedApp.indexOf("companyLoading && !isCheckingCompanySession");
    const routeResolution = authenticatedApp.indexOf("resolveAuthenticatedAppRoute({");
    expect(companyGuard).toBeGreaterThan(-1);
    expect(routeResolution).toBeGreaterThan(companyGuard);

    expect(routeGuard).toContain("isSupplierPartnerRoute && !isSupplierPartnerCompany");
    expect(routeGuard).toContain('decision = { kind: "redirect", to: "/tracking" }');
  });

  it("keeps /sp as a namespace URL that lands on SP Reports now the Overview is retired", () => {
    expect(erpRoutes).toContain('<Route path="/sp">\n        <Redirect replace to="/sp/reports" />');
    expect(erpRoutes).toContain('<Route path="/sp/reports" component={SpReports} />');
  });
});
