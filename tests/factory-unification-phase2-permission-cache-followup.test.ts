import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { companyQueryKey } from "../client/src/lib/companyQueryScope";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const factoryPage = (name: string) => source(`client/src/pages/factory/${name}`);

describe("Factory Phase 2 selected-company access and query isolation", () => {
  it("scopes production overview access, financial and attendance reads", () => {
    const code = factoryPage("dailyproductionreport/useDailyProductionReport.tsx");
    expect(code).toContain('companyQueryKey("/api/factory/my-access", selectedCompany?.id)');
    expect(code).toContain("myAccess.hasFactoryAccess === true");
    for (const endpoint of ["/api/factory/production-value-report", "/api/factory/workers/attendance-report", "/api/factory/monthly-salary-summary"]) {
      expect(code).toContain(`companyQueryKey("${endpoint}", selectedCompany?.id`);
    }
  });

  it("fails closed on Wipers tabs and discards previous-company carts", () => {
    const code = factoryPage("WipersReEntry.tsx");
    expect(code).toContain("const showWipersReEntry = accessReady &&");
    expect(code).toContain('companyQueryKey("/api/factory/my-access", selectedCompany?.id)');
    expect(code).toContain("setCart([])");
    expect(code).toContain("setCleanupSelectedIds(new Set())");
  });

  it("keeps bale-history permissions, pagination and order lookups scoped", () => {
    const code = factoryPage("baleshistory/useBalesHistoryModel.tsx");
    expect(code).toContain('companyQueryKey("/api/factory/my-access", selectedCompany?.id)');
    expect(code).toContain("const scopedAccess =");
    expect(code).toContain('companyQueryKey("/api/factory/bales", selectedCompany?.id, returnToStockBale?.bale?.id, "order-info")');
    expect(code).not.toContain("placeholderData: (prev) => prev");
    expect(code).toContain("setSelectedIds(new Set())");
  });

  it("conceals bale cost columns until same-company permissions resolve", () => {
    for (const name of ["FactoryBaleProductAllMonths.tsx", "FactoryBaleProductMonthDetail.tsx"]) {
      const code = factoryPage(`bale-product-history/${name}`);
      expect(code).toContain("myAccess?.companyId === selectedCompany?.id");
      expect(code).toContain("myAccess?.hasFactoryAccess === true");
      expect(code).toContain("myAccess?.hideAllCosts !== true");
      expect(code).toContain('["bale_history_cost_per_kg", "bale_history_total_cost"]');
      expect(code).toContain('companyQueryKey("/api/factory/bale-product-history", selectedCompany?.id');
    }
  });

  const pageQueries: Record<string, string[]> = {
    "FactoryOpeningBalanceEdit.tsx": ["/api/factory/raw-stock/opening-balance", "/api/factory/suppliers"],
    "FactoryMixOptimizer.tsx": ["/api/factory/bale-products?profile=picker", "/api/factory/suppliers"],
    "FactoryStockBaleList.tsx": ["/api/factory/bale-stock-list"],
    "WasteDispatch.tsx": ["/api/factory/waste-dispatch/bales", "/api/factory/waste-dispatch/history"],
    "FactoryStatusBuilder.tsx": ["/api/factory/status-builder/sheets", "/api/factory/status-builder/log"],
  };
  for (const [name, endpoints] of Object.entries(pageQueries)) {
    it(`scopes ${name} reads`, () => {
      const code = factoryPage(name);
      for (const endpoint of endpoints) expect(code).toContain(`companyQueryKey("${endpoint}", selectedCompany?.id`);
    });
  }

  it("does not keep Status Builder sheets and autosave timers after company change", () => {
    const code = factoryPage("FactoryStatusBuilder.tsx");
    expect(code).toContain("clearTimeout(autosaveTimerRef.current)");
    expect(code).toContain("setLocalSheets([])");
    expect(code).toContain("setInitialised(false)");
    expect(code).toContain("}, [selectedCompany?.id]);");
  });

  it("clears invoice and optimizer drafts when the selected company changes", () => {
    const invoice = factoryPage("FactoryInvoiceCreate.tsx");
    expect(invoice).toContain("setSelectedCustomerId(\"\")");
    expect(invoice).toContain("setOrderId(null)");
    expect(invoice).toContain("lastCompanyRef.current = selectedCompany?.id");
    const optimizer = factoryPage("FactoryMixOptimizer.tsx");
    expect(optimizer).toContain("setTargetProduct(\"\")");
    expect(optimizer).toContain("setMaterials([{ supplierId:");
  });

  it("isolate dispatch batch detail, invoice preview and audit by selected company", () => {
    const code = factoryPage("FactoryDispatchBatchDetail.tsx");
    for (const path of ["`/api/factory/dispatch-batches/${batchId}`", "`/api/factory/dispatch-batches/${batchId}/invoice-preview`", "`/api/factory/dispatch-batches/${batchId}/audit`"]) {
      expect(code).toContain(`companyQueryKey(${path}, selectedCompany?.id)`);
    }
  });

  it("uses URL-first company-specific keys without using URL parameters as authorization", () => {
    const a = companyQueryKey("/api/factory/workers/attendance-report", 101, "2026-11-01", "2026-11-10");
    const b = companyQueryKey("/api/factory/workers/attendance-report", 102, "2026-11-01", "2026-11-10");
    expect(a[0]).toBe("/api/factory/workers/attendance-report");
    expect(a).not.toEqual(b);
  });
});
