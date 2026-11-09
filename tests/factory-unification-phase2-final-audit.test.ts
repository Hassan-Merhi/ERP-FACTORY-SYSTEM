import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { companyQueryKey } from "../client/src/lib/companyQueryScope";
import { factoryActionCapabilities } from "../shared/factoryActionCapabilities";

const code = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Factory Phase 2 further source coverage", () => {
  it("locks nested Factory hub navigation to selected-company access", () => {
    for (const filename of [
      "FactoryBalesHub.tsx",
      "FactoryPayrollHub.tsx",
      "FactoryEmployeesHub.tsx",
      "FactorySupplierHub.tsx",
      "FactoryPartiesHub.tsx",
      "FactoryProductionIntelHub.tsx",
      "FactoryImport.tsx",
      "FactoryKpis.tsx",
    ]) {
      const src = code("client/src/pages/factory/" + filename);
      expect(src, filename).toContain('companyQueryKey("/api/factory/my-access", selectedCompany?.id)');
      expect(src, filename).toContain("myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true");
    }
  });

  it("keeps financial and operational records company scoped", () => {
    const expected: Record<string, string[]> = {
      "FactoryInvoices.tsx": ["/api/factory/customers", "/api/factory/customer-orders"],
      "FactoryPendingInvoices.tsx": ["status=PENDING_VERIFICATION", "status=VERIFIED", "status=FINALIZED"],
      "FactoryDispatchBatches.tsx": ["/api/factory/dispatch-batches", "/api/factory/dispatch-reports/summary"],
      "FactoryCustomerStatement.tsx": ["/api/factory/customer-price-lists", "/api/factory/customers"],
      "FactorySheetsAndSacks.tsx": ["/api/factory/sheets-sacks", "/api/factory/my-access"],
      "FactoryDashboard.tsx": ["/api/factory/dashboard", "/api/factory/containers"],
      "FactoryEmployeePayrollTab.tsx": ["/api/factory/employee-payroll-preview", "/api/factory/employees"],
      "BaleStockEntry.tsx": ["/api/factory/stock-entry/production-session", "/api/factory/my-access"],
      "FactoryBaleRelabeling.tsx": ["/api/factory/bales/relabel/sessions", "/api/factory/my-access"],
    };
    for (const [filename, endpoints] of Object.entries(expected)) {
      const src = code("client/src/pages/factory/" + filename);
      for (const endpoint of endpoints) {
        expect(src, filename).toContain(endpoint);
      }
      expect(src, filename).toContain("companyQueryKey(");
      expect(src, filename).toContain("selectedCompany?.id");
    }
    expect(companyQueryKey("/api/factory/sheets-sacks", 11)).not.toEqual(
      companyQueryKey("/api/factory/sheets-sacks", 12),
    );
  });

  it("prevents using absent or cross-company permissions to expose Sheets & Sacks mutations", () => {
    const src = code("client/src/pages/factory/FactorySheetsAndSacks.tsx");
    expect(src).not.toContain("const canEdit = !myAccess ||");
    expect(src).toContain("accessReady &&");
    expect(src).toContain("myAccess?.companyId === selectedCompany?.id");
    expect(src).toContain("myAccess?.hasFactoryAccess");
  });

  it("keeps the dispatch capability matrix fail closed regardless of UI state", () => {
    for (const role of ["View Only", "Create Only", "Admin", "Owner", "Developer"]) {
      const c = factoryActionCapabilities({ role, hasFactoryAccess: false });
      expect(c["dispatch.close"]).toBe(false);
      expect(c["dispatch.approve-discrepancy"]).toBe(false);
      expect(c["dispatch.reopen"]).toBe(false);
      expect(c["production.manage-bonuses"]).toBe(false);
    }
    expect(factoryActionCapabilities({ role: "Developer", hasFactoryAccess: true })["production.manage-bonuses"]).toBe(false);
  });

  it("keeps detail mutation refreshes compatible with company-keyed reads", () => {
    const worker = code("client/src/pages/factory/factoryworkerdetail/useFactoryWorkerDetailModel.tsx");
    const invoice = code("client/src/pages/factory/factoryinvoicedetail/useFactoryInvoiceDetailModel.tsx");
    const customer = code("client/src/pages/factory/FactoryCustomerStatement.tsx");
    expect(worker).toContain('companyQueryKey("/api/factory/workers", selectedCompany?.id');
    expect(worker).toContain('invalidateQueries({ queryKey: ["/api/factory/workers"] })');
    expect(invoice).toContain('companyQueryKey("/api/factory/customer-orders", selectedCompany?.id, orderId)');
    expect(invoice).toContain('invalidateQueries({ queryKey: ["/api/factory/customer-orders"] })');
    expect(customer).toContain('invalidateQueries({ queryKey: ["/api/factory/customer-price-lists"] })');
  });

  it("guards against missing company and missing permission payload simultaneously", () => {
    for (const file of [
      "FactoryBalesHub.tsx", "FactoryPayrollHub.tsx", "FactoryInvoicing.tsx",
      "FactorySheetsAndSacks.tsx", "FactoryKpis.tsx",
    ]) {
      const src = code("client/src/pages/factory/" + file);
      expect(src).not.toContain("&& myAccess.hasFactoryAccess");
      expect(src).toContain("myAccess?.hasFactoryAccess === true");
    }
    const staff = code("client/src/pages/factory/FactoryProductionTargets.tsx");
    expect(staff).not.toContain("&& access.hasFactoryAccess");
    expect(staff).toContain("access?.hasFactoryAccess === true");
  });

  it("maintains a read-only inventory tool for unresolved cache and permission patterns", () => {
    const src = code("scripts/audit-factory-phase2.mjs");
    expect(src).toContain("--strict");
    expect(src).toContain("unscoped-access-query");
    expect(src).toContain("review-fail-open-access");
    expect(src).not.toContain("writeFileSync(");
  });
});
