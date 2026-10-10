import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("Phase 7 company access boundary", () => {
  it("keeps explicit membership while honoring the existing Developer company scope", () => {
    const boundary = source("server/security/companyAccessBoundary.ts");
    const companyRoutes = source("server/routes/auth/companyAccessRoutes.ts");

    expect(boundary).toContain("resolveAuthorizedCompanyId");
    expect(boundary).toContain("isPrivilegedRole");
    expect(boundary).toContain("await assertCompanyAccess(context.userId, targetCompanyId)");
    expect(boundary).toContain("CROSS_COMPANY_FORBIDDEN");
    expect(boundary).toContain("COMPANY_ACCESS_DENIED");
    expect(boundary).toContain("req.session?.currentRole ?? req.user?.role");

    // Developer company selection is synthetic in the existing selector and
    // set-company route, so the central boundary must resolve the same scope.
    expect(companyRoutes).toContain('req.user.role === "Developer"');
    expect(boundary).toContain('entry.role === "Developer"');
    expect(boundary).toContain("await storage.getAllCompanies()");
    expect(boundary).toContain("await storage.getUserCompaniesWithRoles(userId)");
  });

  it("routes transfer authorization through the central boundary", () => {
    const transferContext = source("server/routes/transfers/transferRequestContext.ts");

    expect(transferContext).toContain("getCompanyAccessContext");
    expect(transferContext).toContain("assertCompaniesAccess");
    expect(transferContext).toContain("assertCompanyAccess");
    expect(transferContext).not.toContain("storage.getUserCompaniesWithRoles");
  });

  it("protects cross-company financial exports with membership checks", () => {
    const exportRoute = source("server/routes/netPositionMonthlyExcelRoute.ts");

    expect(exportRoute).toContain("resolveAuthorizedCompanyId(req, req.query.companyId)");
    expect(exportRoute).toContain("requireNonPOS");
    expect(exportRoute).not.toContain("isAdminOrDev && requestedCompanyId");
  });

  it("removes route-local role-only company access from GIT container and agent reports", () => {
    const helpers = source("server/lib/gitHelpers.ts");
    const routes = source("server/routes/git/gitReportRoutes.ts");

    expect(helpers).toContain("getAccessibleCompanyIds as getMembershipCompanyIds");
    expect(helpers).toContain("isPrivilegedRole");
    expect(helpers).toContain("COMPANY_ACCESS_DENIED");
    expect(helpers).not.toContain("Admin / Developer: all companies");
    expect(helpers).not.toContain("userCompanyRoles");
    expect(routes).toContain("resolveGitCompanyScope");
    expect(routes).toContain("code: scope.code");
  });

  it("scopes voucher, supplier and offload reads to accessible companies", () => {
    const vouchers = source("server/routes/vouchers/voucherQueryRoutes.ts");
    const offloads = source("server/routes/offloadRoutes.ts");

    expect(vouchers).toContain("assertActiveCompanyAccess(req)");
    expect(vouchers).toContain("resolveAuthorizedCompanyId(req, companyId)");
    expect(vouchers).toContain("getAccessibleCompanyIds(access.userId)");
    expect(vouchers).not.toContain("const companies = await storage.getAllCompanies()");
    expect(offloads).toContain("eq(vouchers.companyId, offload.companyId)");
    expect(offloads).toContain("COMPANY_ACCESS_DENIED");
  });

  it("resolves Developer scope from the account role without giving Admin a synthetic bypass", () => {
    const boundary = source("server/security/companyAccessBoundary.ts");

    // set-company accepts req.user.role === "Developer" and fabricates a company
    // role that is never written to user_company_roles. The boundary mirrors that
    // explicit exception, while Admin remains tied to real company membership.
    expect(boundary).toContain("await storage.getUser(userId)");
    expect(boundary).toContain('?.role === "Developer"');
    expect(boundary).toContain('if (context.role === "Developer")');
    expect(boundary).not.toContain('if (context.role === "Developer" || context.role === "Admin")');
    expect(boundary).toContain("await assertCompanyAccess(context.userId, context.activeCompanyId)");
  });

  // server/routes/containers/containerFreightReadRoutes.ts used to be in this
  // list. fb40ef6 moved it off getAccessibleCompanyIds: its reads now either
  // carry the session company into the WHERE clause via the ...ForCompany
  // storage accessors, or fetch and then reject a foreign row explicitly. The
  // file is mixed, so no single source-text claim describes it honestly, and
  // pinning helper names here would only re-break the next time the mechanism
  // improves. Its boundary is asserted by outcome instead — a cross-company
  // read is refused — in tests/purchase-order-write-routes.test.ts.
  it("routes remaining cross-company page scopes through the central boundary", () => {
    const routeFiles = [
      "server/routes/erp-payroll/runs.ts",
      "server/routes/stats/statsDataRoutes.ts",
      "server/routes/helpers/supplierBalanceHelpers.ts",
      "server/routes/reportsContainerTrackingRoutes.ts",
      // server/routes/reportsClosingStockRoutes.ts left this list in wave 11:
      // its only cross-company read was the target-company check of the
      // closing-stock transfer, which is retired (410). Its reports read the
      // session company only.
    ];

    for (const routeFile of routeFiles) {
      const route = source(routeFile);
      expect(route).toContain("getAccessibleCompanyIds");
      expect(route).not.toContain("getUserCompaniesWithRoles");
    }
  });

  it("protects All Daybook list, type, and detail reads with the same company boundary", () => {
    const globalTransactions = source("server/routes/globalTransactionRoutes.ts");

    expect(globalTransactions).toContain("resolveGlobalCompanyScope");
    expect(globalTransactions).toContain("getAccessibleCompanyIds");
    expect(globalTransactions).toContain("assertCompaniesAccess(userId, requested)");
    expect(globalTransactions).toContain("assertCompanyAccess(userId, voucher.companyId)");
    expect(globalTransactions).toContain("sendCompanyAccessError(res, err)");
    expect(globalTransactions).not.toContain("userCompanyRoles");
    expect(globalTransactions).not.toContain('const isAdmin = userRole === "Admin"');
  });
});
