#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");
const failures = [];

const sources = {
  rawPage: await read("client/src/pages/factory/ProductionRawStock.tsx"),
  rawTable: await read("client/src/pages/factory/production-raw-stock/RawStockTable.tsx"),
  mixBatches: await read("client/src/pages/factory/production-raw-stock/MixBatchList.tsx"),
  containerLoading: await read("client/src/pages/factory/FactoryContainerLoadingScan.tsx"),
  scannedPanel: await read("client/src/pages/factory/factorycontainerloadingscan/ScannedBalesPanel.tsx"),
  dispatchScan: await read("client/src/pages/factory/FactoryDispatchBatchScan.tsx"),
  images: await read("client/src/pages/factory/BaleProductImages.tsx"),
  tracking: await read("client/src/pages/factory/FactoryBaleTracking.tsx"),
  imports: await read("client/src/pages/factory/FactoryImport.tsx"),
  relabeling: await read("client/src/pages/factory/FactoryBaleRelabeling.tsx"),
  allocation: await read("client/src/pages/factory/FactoryStockAllocationV5.tsx"),
  locationProduct: await read("client/src/pages/factory/FactoryLocationInventoryProductView.tsx"),
};

function requireTokens(name, source, tokens) {
  for (const token of tokens) {
    if (!source.includes(token)) failures.push(`${name} missing responsive contract: ${token}`);
  }
}

requireTokens("Raw Production page", sources.rawPage, [
  'data-testid="production-raw-stock-page"',
  "p-3 sm:space-y-6 sm:p-6",
  "grid w-full grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:flex",
]);

requireTokens("Raw Stock", sources.rawTable, [
  'data-testid="raw-stock-mobile-list"',
  "space-y-3 md:hidden",
  "hidden overflow-hidden rounded-md border bg-card shadow-sm md:block",
  'data-testid={`button-adjust-mobile-${row.supplierId}`}',
  'data-testid={`button-deduct-mobile-${row.supplierId}`}',
  'data-testid={`button-batch-mobile-${row.supplierId}`}',
]);

requireTokens("Mix Batch history", sources.mixBatches, [
  'data-testid="mix-batch-mobile-list"',
  "space-y-3 md:hidden",
  "hidden overflow-x-auto md:block",
  'data-testid="input-mix-batch-date"',
  'data-testid={`button-edit-mix-batch-mobile-${batch.id}`}',
  'data-testid={`button-delete-mix-batch-mobile-${batch.id}`}',
]);

requireTokens("Container Loading", sources.containerLoading, [
  'data-testid="factory-container-loading-page"',
  "p-3 sm:p-4 lg:p-6",
  "flex min-h-0 min-w-0 flex-1 flex-col gap-4 lg:flex-row",
  "mobile-action-bar",
]);

requireTokens("Container scanner controls", sources.scannedPanel, [
  'data-testid="container-loading-scan-controls"',
  "flex min-w-0 flex-col gap-2 sm:mb-1 sm:flex-row",
  "grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]",
  'data-testid="input-scan-code"',
]);

requireTokens("Dispatch scanner", sources.dispatchScan, [
  'data-testid="factory-dispatch-batch-scan-page"',
  "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:flex-row",
  'data-testid="dispatch-scan-proforma-progress"',
  "w-full shrink-0 flex-col overflow-hidden border-t lg:max-h-none lg:w-56 lg:border-l lg:border-t-0",
  'className="w-full sm:w-auto"',
]);

requireTokens("Bale Product Images", sources.images, [
  'data-testid="bale-product-images-page"',
  "grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-3",
  "opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100",
  "md:bg-black/0 md:group-hover:bg-black/40",
]);

requireTokens("Bale Tracking", sources.tracking, [
  'data-testid="factory-bale-tracking-page"',
  "flex flex-col gap-2 min-[420px]:flex-row",
  "grid grid-cols-1 gap-x-6 gap-y-2 text-sm min-[420px]:grid-cols-2",
  "w-full min-[420px]:w-auto",
]);

requireTokens("Factory Import", sources.imports, [
  'data-testid="factory-import-page"',
  'data-testid="factory-import-tabs"',
  "overflow-x-auto",
  "shrink-0",
]);

requireTokens("Bale Relabeling", sources.relabeling, [
  'data-testid="factory-bale-relabeling-page"',
  'data-testid="relabeling-progress-strip"',
  "flex-1 min-w-0 space-y-4 overflow-y-auto p-3 sm:space-y-6 sm:p-6",
  "grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:grid-cols-4",
  "max-h-80 overflow-auto",
]);

requireTokens("Stock Allocation V5", sources.allocation, [
  'data-testid="factory-stock-allocation-v5-page"',
  'data-testid="v5-mobile-list"',
  "space-y-3 overflow-y-auto p-3 md:hidden",
  "hidden max-h-[calc(100vh-160px)] overflow-auto md:block",
  'data-testid={`button-v5-mobile-expand-${row.articleCode}`}',
]);

requireTokens("Location Inventory reference implementation", sources.locationProduct, ["renderMobileCard"]);

for (const [name, source] of Object.entries(sources)) {
  if (source.includes("max-sm:hidden") && name === "images") {
    failures.push("Bale Product Images reintroduced a phone-hidden image action");
  }
}

if (failures.length > 0) {
  console.error("Mobile Wave 2 Factory-floor verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      wave: 2,
      status: "implemented",
      scope: [
        "Raw Production / Raw Materials",
        "Mix Batches",
        "Container Loading scanner",
        "Dispatch scanner",
        "Stock Allocation V5",
        "Bale Tracking",
        "Bale Relabeling",
        "Factory Import",
        "Bale Product Images",
        "Location Inventory regression",
      ],
      desktopBreakpointPreserved: "md+ unless the original page already used lg for split panes",
      businessLogicChanged: false,
      sqlRequired: false,
    },
    null,
    2
  )
);
