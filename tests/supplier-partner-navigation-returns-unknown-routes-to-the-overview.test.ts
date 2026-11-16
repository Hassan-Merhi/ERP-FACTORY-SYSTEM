import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("Supplier Partner navigation phase 5", () => {
  const routeGuard = read("client/src/app/authenticatedAppRouteGuard.ts");
  const normalizedRouteGuard = routeGuard.replace(/\s+/g, " ");
  const appNavigation = read("client/src/app/useAppNavigation.ts");

  it("returns unknown Supplier Partner routes to the Overview with replacement history", () => {
    expect(routeGuard).toContain("const SUPPLIER_PARTNER_PATHS = new Set");
    expect(normalizedRouteGuard).toContain(
      "isSupplierPartnerCompany && isSupplierPartnerRoute && !SUPPLIER_PARTNER_PATHS.has(currentLocation)"
    );
    expect(routeGuard).toContain('decision = { kind: "redirect", to: "/sp" }');
  });

  it("uses deterministic Supplier Partner parent routes for Escape and Back", () => {
    expect(appNavigation).toContain('if (cleanPath === "/sp/reports") return "/sp"');
    expect(appNavigation).toContain('if (cleanPath === "/sp/opening-stock") return "/sp"');
    expect(appNavigation).toContain('if (cleanPath === "/sp/aliases") return "/sp"');
    expect(appNavigation).toContain('if (cleanPath === "/sp/setup") return "/sp"');
    expect(appNavigation).toContain('return "/sp/setup"');
    expect(appNavigation).toContain("getSupplierPartnerParent(pathname) ?? getParentRoute(pathname)");
  });

  it("keeps compatibility migration redirects replacement-based", () => {
    expect(routeGuard).toContain('currentLocation === "/sp/migration"');
    expect(routeGuard).toContain('currentLocation === "/sp/gc-migration"');
    expect(routeGuard).toContain('decision = { kind: "redirect", to: "/sp/setup" }');
  });
});
