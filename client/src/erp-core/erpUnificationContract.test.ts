import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("ERP unification final regression contracts", () => {
  it("keeps the generic barrel free from eager React Hook Form evaluation", () => {
    const barrel = source("client/src/erp-core/index.ts");
    const customers = source("client/src/pages/Customers.tsx");
    expect(barrel).not.toContain('from "@/components/ui/form"');
    expect(customers).toContain('from "@/components/ui/form"');
    expect(barrel).not.toContain('from "./erpData"');
    expect(customers).toContain('from "@/erp-core/erpData"');
    expect(barrel).toContain('export { ErpFormActions, ErpPendingButton }');
  });

  it("uses the same company-aware access identity for routes, sidebar and boundary", () => {
    const routes = source("client/src/routes/ErpRoutes.tsx");
    const sidebar = source("client/src/components/AppSidebar.tsx");
    const boundary = source("client/src/app/ErpAccessBoundary.tsx");
    for (const text of [routes, sidebar, boundary]) {
      expect(text).toContain("erpPageAccessQueryOptions(");
    }
    expect(routes).not.toContain('queryKey: ["/api/my-erp-pages"]');
    expect(routes).toContain("canEnterErpGuardedRoute");
  });

  it("keeps Stock Query server paginated instead of silently truncating results", () => {
    const file = source("client/src/pages/StockQuery.tsx");
    expect(file).toContain("useErpServerPagination");
    expect(file).toContain("erpCompanyDataKey");
    expect(file).not.toContain('pageSize: "200"');
    expect(file).toContain("isFactory");
  });

  it("protects voucher and supplier exports while leaving statement math in their pages", () => {
    const vouchers = source("client/src/pages/OptionalVouchers.tsx");
    const suppliers = source("client/src/pages/Suppliers.tsx");
    const reports = source("client/src/pages/ProfessionalFinancialStatements.tsx");
    expect(vouchers).toContain("invalidateErpDataFamilies");
    expect(suppliers).toContain("mayExportSupplier.allowed");
    expect(suppliers).toContain("supplierLedgerToExportRows(unifiedLedger)");
    expect(reports).toContain("PROVISIONAL FINANCIAL STATEMENTS — NOT CERTIFIED");
  });

  it("does not duplicate ERP core imports across migrated pages", () => {
    const migrated = [
      "client/src/pages/Customers.tsx",
      "client/src/pages/Suppliers.tsx",
      "client/src/pages/StockInSalesReport.tsx",
      "client/src/pages/ItemMarketAnalysis.tsx",
    ];
    for (const path of migrated) {
      const imports = source(path).match(/from "@\/erp-core";/g) ?? [];
      expect(imports.length, path).toBe(1);
    }
  });
});
