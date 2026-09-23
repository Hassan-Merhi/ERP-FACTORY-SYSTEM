import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile responsiveness Phase 7 Factory workflows", () => {
  it("provides shared Factory mobile workflow primitives", () => {
    const factoryMobile = source("client/src/components/ui/factory-mobile.tsx");

    for (const token of [
      "FactoryMobilePage",
      "FactoryMobileHeader",
      "FactoryMobileHeaderActions",
      "FactoryMobileWorkflowGrid",
      "FactoryMobileScannerPanel",
      "FactoryMobileStatus",
      "FactoryMobileActionBar",
      'data-factory-mobile-page="true"',
      'data-factory-mobile-scanner="true"',
      'data-factory-mobile-action-bar="true"',
      "env(safe-area-inset-bottom)",
      "min-[360px]:grid-cols-2",
    ]) {
      expect(factoryMobile).toContain(token);
    }
  });

  it("applies phone containment and touch behavior to the full Factory workspace", () => {
    const shell = source("client/src/app/FactoryShell.tsx");

    for (const token of [
      'data-factory-workspace="true"',
      "factoryWorkspaceClasses",
      "max-sm:[&_button]:min-h-11",
      "max-sm:[&_input]:min-h-11",
      "max-sm:[&_input]:text-base",
      "[&_form]:max-w-full",
      "[&_[data-mobile-data-list]]:max-w-full",
      "env(safe-area-inset-bottom)",
    ]) {
      expect(shell).toContain(token);
    }
  });

  it("converts bale stock entry headers, summaries, and tabs without changing routes", () => {
    const page = source("client/src/pages/factory/BaleStockEntry.tsx");
    const summary = source("client/src/pages/factory/bale-stock-entry/DailyStockSummary.tsx");
    const reportRoute = source("server/routes/factory/bales/balesReportRoutes.ts");

    expect(page).toContain("FactoryMobilePage");
    expect(page).toContain("FactoryMobileHeaderActions");
    expect(page).toContain('aria-label="Bale stock entry sections"');
    expect(page).toContain('data-testid="tab-stock-entry"');
    expect(page).toContain('data-testid="tab-ground-scan"');
    expect(summary).toContain('data-factory-daily-summary="true"');
    expect(summary).toContain("min-[420px]:grid-cols-2");
    expect(summary).toContain("/api/factory/bales/daily-summary");
    expect(summary).toContain("normalizeDailySummaryRows");
    expect(summary).toContain("Array.isArray(payload)");
    expect(reportRoute).toContain("res.json(resultRows(rows));");
  });

  it("makes the scanner accessible and phone safe", () => {
    const scanner = source("client/src/pages/factory/bale-stock-entry/StockEntryScanner.tsx");

    for (const token of [
      "FactoryMobileScannerPanel",
      'role="combobox"',
      'aria-autocomplete="list"',
      "aria-activedescendant",
      'role="listbox"',
      'role="option"',
      'type="button"',
      "enterKeyHint=\"done\"",
      "max-sm:relative",
      "FactoryMobileStatus",
    ]) {
      expect(scanner).toContain(token);
    }

    expect(scanner).toContain("onSelectProduct(target)");
    expect(scanner).toContain("onScanKeyDown(e)");
  });

  it("uses mobile cart cards while preserving the desktop stock-entry table", () => {
    const cart = source("client/src/pages/factory/bale-stock-entry/StockEntryCart.tsx");
    const sidebar = source("client/src/pages/factory/bale-stock-entry/StockEntrySidebar.tsx");

    for (const token of [
      "ResponsiveDataList",
      "ResponsiveDataListField",
      "ResponsiveDataListActions",
      'className="md:hidden"',
      'className="hidden overflow-hidden rounded-xl border bg-card/50 md:block"',
      'scrollLabel="Bales ready for stock entry"',
      'minimumWidth="56rem"',
      "inputMode=\"numeric\"",
      "inputMode=\"decimal\"",
    ]) {
      expect(cart).toContain(token);
    }

    expect(sidebar).toContain("FactoryMobileActionBar");
    expect(sidebar).toContain('data-testid="button-confirm-stock-entry"');
    expect(sidebar).toContain("xl:sticky xl:top-6");
  });

  it("keeps shared Factory layout primitives free from business mutations", () => {
    const factoryMobile = source("client/src/components/ui/factory-mobile.tsx");

    for (const forbidden of [
      "useMutation(",
      "queryClient",
      "adjustInventory",
      "costPerKg",
      "ledgerAccount",
      'fetch("/api/',
    ]) {
      expect(factoryMobile).not.toContain(forbidden);
    }
  });
});
