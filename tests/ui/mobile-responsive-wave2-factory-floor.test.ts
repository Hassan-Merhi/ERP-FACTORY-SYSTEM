import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Mobile Wave 2 Factory floor workflows", () => {
  it("uses phone cards for Raw Stock and Mix Batches while retaining desktop tables", () => {
    const raw = source("client/src/pages/factory/production-raw-stock/RawStockTable.tsx");
    const mixes = source("client/src/pages/factory/production-raw-stock/MixBatchList.tsx");

    expect(raw).toContain('data-testid="raw-stock-mobile-list"');
    expect(raw).toContain("space-y-3 md:hidden");
    expect(raw).toContain("md:block");
    expect(raw).toContain('data-testid={`button-adjust-mobile-${row.supplierId}`}');
    expect(raw).toContain('data-testid={`button-deduct-mobile-${row.supplierId}`}');
    expect(raw).toContain('data-testid={`button-batch-mobile-${row.supplierId}`}');

    expect(mixes).toContain('data-testid="mix-batch-mobile-list"');
    expect(mixes).toContain("space-y-3 md:hidden");
    expect(mixes).toContain("hidden overflow-x-auto md:block");
    expect(mixes).toContain('data-testid="input-mix-batch-date"');
  });

  it("keeps Factory loading scanners usable without permanent phone side panes", () => {
    const page = source("client/src/pages/factory/FactoryContainerLoadingScan.tsx");
    const panel = source("client/src/pages/factory/factorycontainerloadingscan/ScannedBalesPanel.tsx");
    const dispatch = source("client/src/pages/factory/FactoryDispatchBatchScan.tsx");

    expect(page).toContain('data-testid="factory-container-loading-page"');
    expect(page).toContain("flex min-h-0 min-w-0 flex-1 flex-col gap-4 lg:flex-row");
    expect(page).toContain("mobile-action-bar");

    expect(panel).toContain('data-testid="container-loading-scan-controls"');
    expect(panel).toContain("flex min-w-0 flex-col gap-2 sm:mb-1 sm:flex-row");
    expect(panel).toContain("grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]");
    expect(panel).toContain('data-testid="input-scan-code"');

    expect(dispatch).toContain('data-testid="factory-dispatch-batch-scan-page"');
    expect(dispatch).toContain("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:flex-row");
    expect(dispatch).toContain("lg:w-56 lg:border-l lg:border-t-0");
  });

  it("keeps destructive image actions visible on touch and hover-driven on desktop", () => {
    const images = source("client/src/pages/factory/BaleProductImages.tsx");

    expect(images).toContain("opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100");
    expect(images).toContain("md:bg-black/0 md:group-hover:bg-black/40");
    expect(images).toContain("min-[360px]:grid-cols-2");
  });

  it("provides phone-first controls for allocation, tracking, imports and relabeling", () => {
    const allocation = source("client/src/pages/factory/FactoryStockAllocationV5.tsx");
    const tracking = source("client/src/pages/factory/FactoryBaleTracking.tsx");
    const imports = source("client/src/pages/factory/FactoryImport.tsx");
    const relabeling = source("client/src/pages/factory/FactoryBaleRelabeling.tsx");

    expect(allocation).toContain('data-testid="v5-mobile-list"');
    expect(allocation).toContain("md:hidden");
    expect(allocation).toContain("md:block");
    expect(allocation).toContain('data-testid={`button-v5-mobile-expand-${row.articleCode}`}');

    expect(tracking).toContain("flex flex-col gap-2 min-[420px]:flex-row");
    expect(tracking).toContain("grid grid-cols-1 gap-x-6 gap-y-2 text-sm min-[420px]:grid-cols-2");

    expect(imports).toContain('data-testid="factory-import-tabs"');
    expect(imports).toContain("overflow-x-auto");

    expect(relabeling).toContain('data-testid="relabeling-progress-strip"');
    expect(relabeling).toContain("overflow-x-auto");
    expect(relabeling).toContain("max-h-80 overflow-auto");
  });

  it("does not move Factory business rules into the Wave 2 verifier", () => {
    const verifier = source("scripts/verify-mobile-responsive-wave2-factory-floor.mjs");
    for (const forbidden of ["useMutation(", "costPerKg =", "adjustInventory", 'fetch("/api/']) {
      expect(verifier).not.toContain(forbidden);
    }
  });
});
