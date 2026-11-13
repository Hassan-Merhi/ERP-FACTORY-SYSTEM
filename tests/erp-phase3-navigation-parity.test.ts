import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ERP_MOBILE_PRIMARY_PATHS, erpRegisteredNavigationUrls } from "../client/src/app/erpPageRegistry";
import { isErpNavigationItemVisible, isErpRouteRoleAllowed } from "../shared/erpNavigationPolicy";

const routes = readFileSync(new URL("../client/src/routes/ErpRoutes.tsx", import.meta.url), "utf8");

describe("ERP Phase 3 desktop/phone/route parity", () => {
  it("keeps every registered ERP sidebar destination routable", () => {
    for (const path of erpRegisteredNavigationUrls()) {
      expect(routes, `Missing route for ERP navigation destination ${path}`).toContain(JSON.stringify(path));
    }
  });

  it("keeps every primary phone destination in the ERP page registry", () => {
    const known = new Set(erpRegisteredNavigationUrls());
    for (const urls of Object.values(ERP_MOBILE_PRIMARY_PATHS)) {
      for (const url of urls) expect(known.has(url), `Missing phone destination ${url}`).toBe(true);
    }
  });

  it("cannot expose developer-only tools through an Admin's full-access page grant", () => {
    const access = { fullAccess: true, pageKeys: ["accounts", "settings", "analytics", "pos"] };
    for (const path of ["/accounting/toolbox", "/ai-validation", "/ai-command-center", "/cost-centers"]) {
      expect(isErpRouteRoleAllowed(path, "Admin")).toBe(false);
      expect(isErpNavigationItemVisible({ path, role: "Admin", access })).toBe(false);
      expect(isErpRouteRoleAllowed(path, "Developer")).toBe(true);
    }
  });

  it("keeps ERP supplier returns strictly Admin/Developer only", () => {
    for (const role of ["Normal User", "ERP Tester", "Create Only", "POS", "Owner"]) {
      expect(isErpRouteRoleAllowed("/supplier-returns", role)).toBe(false);
      expect(isErpNavigationItemVisible({ role, path: "/supplier-returns" })).toBe(false);
    }
    expect(isErpRouteRoleAllowed("/supplier-returns", "Admin")).toBe(true);
    expect(isErpRouteRoleAllowed("/supplier-returns", "Developer")).toBe(true);
  });

  it("hides unpermitted finance pages consistently from a restricted ERP user", () => {
    const access = { fullAccess: false, pageKeys: ["pos"] };
    for (const path of ["/accounts", "/daybook", "/vouchers", "/sales-report"]) {
      expect(isErpNavigationItemVisible({ path, role: "Normal User", access })).toBe(false);
    }
    expect(isErpNavigationItemVisible({ path: "/pos", role: "Normal User", access })).toBe(true);
  });
});
