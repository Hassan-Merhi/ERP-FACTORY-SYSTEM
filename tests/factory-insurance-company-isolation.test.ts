import { describe, expect, it } from "vitest";
import { resolveRequestCompanyId } from "../server/services/security/requestCompanyScope";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

const routeSource = readModuleFamily(new URL("../server/routes/factory/factoryInsuranceRoutes.ts", import.meta.url));

describe("factory insurance company isolation", () => {
  const request = {
    session: { userId: 1, currentRole: "Admin", factoryCompanyId: 10 },
    body: {},
    query: {},
  };

  it("accepts the active session company", () => {
    expect(resolveRequestCompanyId(request)).toBe(10);
  });

  it("denies a request-supplied cross-company id even for Admin", () => {
    expect(() => resolveRequestCompanyId({ ...request, body: { companyId: 11 } })).toThrowError();
  });

  it("uses the shared request company scope in the production route", () => {
    expect(routeSource).toContain('from "../../services/security/requestCompanyScope"');
    expect(routeSource).toContain("resolveRequestCompanyId(req)");
    expect(routeSource).not.toContain("function getFactoryCompanyId");
    expect(routeSource).not.toContain("function resolveRequestCompanyId");
  });

  it("does not select the operating company directly from request data", () => {
    expect(routeSource).not.toContain("req.body.companyId ||");
    expect(routeSource).not.toContain("req.query.companyId ?");
  });

  it("keeps reads, writes, toggles, deletion, and generation scoped", () => {
    expect(routeSource.match(/resolveRequestCompanyId\(req\)/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
    expect(routeSource).toContain("eq(insuranceMembers.companyId, companyId)");
    expect(routeSource).toContain("eq(vouchers.companyId, companyId)");
    expect(routeSource).toContain('"/api/insurance/admin/clear-all"');
    expect(routeSource).toContain('requireRole("Admin", "Developer")');
  });

  it("routes insurance voucher creation through the central posting service", () => {
    expect(routeSource).toContain("postBalancedVoucherTx");
    expect(routeSource).toContain('from "../../services/accounting/centralPostingEngine"');
    expect(routeSource).toContain("createDatabasePostingDependencies()");
    expect(routeSource).toContain('sourceModule: "ERP"');
    expect(routeSource).not.toContain("tx.insert(vouchers)");
    expect(routeSource).not.toContain("tx.insert(voucherEntries)");
  });
});
