#!/usr/bin/env node

import fs from "node:fs";

const failures = [];
const read = (file) => fs.readFileSync(file, "utf8");
const expectTokens = (file, tokens) => {
  const source = read(file);
  for (const token of tokens) {
    if (!source.includes(token)) failures.push(`${file}: missing ${token}`);
  }
};

expectTokens("client/src/app/ErpShell.tsx", [
  'import "@/erp-mobile-operations.css"',
  'data-erp-route={routePath}',
  '"w-full min-w-0 max-w-full',
]);

// #2173 rewrote this stylesheet without !important (every rule names the ERP route, so
// specificity wins) and moved per-page phone behaviour onto the components: hover-revealed
// buttons use the `touch` variant (checked repo-wide by the Phase 1 verifier) and landscape
// phones keep the card lists through the `phone-land` variant (checked per page below).
expectTokens("client/src/erp-mobile-operations.css", [
  "@media (max-width: 767px)",
  "(hover: none) and (pointer: coarse) and (max-height: 500px)",
  ".erp-mobile-scroll-tabs",
  ".erp-mobile-touch-target",
  "min-height: 44px",
  "min-width: 44px",
]);
for (const file of [
  "client/src/pages/InventoryHub.tsx",
  "client/src/pages/StockHub.tsx",
  "client/src/pages/SalesToolsHub.tsx",
  "client/src/pages/PartiesHub.tsx",
]) {
  expectTokens(file, ["erp-mobile-scroll-tabs", "shrink-0"]);
}

expectTokens("client/src/pages/containers/ActiveContainersTable.tsx", [
  "flex flex-col gap-3 hover-elevate sm:flex-row",
  "erp-mobile-touch-target opacity-0 group-hover:opacity-100 touch:opacity-100",
  'className="w-full sm:w-auto"',
  "sm:w-36",
]);

expectTokens("client/src/pages/containers/ContainerFilters.tsx", [
  "w-full min-w-0 sm:flex-1 sm:min-w-[200px]",
  "overflow-x-auto",
  "w-[min(20rem,calc(100vw-1rem))]",
]);

expectTokens("client/src/pages/transactionjournal/components/JournalFilters.tsx", [
  'className="w-full min-w-0 space-y-2 sm:w-auto"',
  'className="w-full sm:w-[150px]"',
  'className="w-full sm:w-[110px]"',
  'className="w-full sm:w-[130px]"',
  'className="flex flex-col gap-2 sm:flex-row"',
]);

// These operational pages already ship explicit mobile-card/list alternatives.
const mobileDataPages = [
  "client/src/pages/StockQuery.tsx",
  "client/src/pages/StockOTW.tsx",
  "client/src/pages/OffloadItemSearch.tsx",
  "client/src/pages/StockTransfers.tsx",
  "client/src/pages/OptionalVouchers.tsx",
  "client/src/pages/CombinedInventory.tsx",
  "client/src/pages/StockItemHistory.tsx",
  "client/src/pages/StockItemVouchers.tsx",
  "client/src/pages/BarcodeManager.tsx",
  "client/src/pages/OrphanedRecords.tsx",
  "client/src/pages/DeletedItems.tsx",
];
for (const file of mobileDataPages) {
  const source = read(file);
  if (!source.includes("md:hidden")) failures.push(`${file}: missing existing mobile data view`);
  // Landscape phones are wider than md but keep the phone card list (#2173 phone-land variant).
  if (!source.includes("phone-land:block")) failures.push(`${file}: phone card list not kept on landscape phones`);
}

// Core ERP route coverage for the operational wave.
const routes = read("client/src/routes/ErpRoutes.tsx");
for (const route of [
  "/accounts",
  "/parties",
  "/containers",
  "/offloads/:id",
  "/inventory",
  "/stock",
  "/daybook",
  "/transaction-journal",
  "/vouchers",
  "/sales-tools",
  "/sales-report",
  "/opening-stock",
  "/closing-stock-summary",
  "/po-import",
  "/import-stock-items",
  "/optional-vouchers",
  "/barcode-manager",
  "/deleted-items",
]) {
  if (!routes.includes(`"${route}"`)) failures.push(`ErpRoutes: missing Wave 3 route ${route}`);
}

// Reports/opening/closing already have responsive page contracts; Wave 3 protects them rather than redesigning formulas.
expectTokens("client/src/pages/OpeningStockSummary.tsx", ["grid-cols-2", "sm:grid-cols-7", "hidden sm:block"]);
expectTokens("client/src/pages/ClosingStockSummary.tsx", ["grid-cols-2", "sm:grid-cols-4", "sm:hidden"]);
expectTokens("client/src/pages/Vouchers.tsx", ["VoucherMobileTabs", "VoucherDesktopNav"]);

if (failures.length) {
  console.error("Mobile Wave 3 ERP operations verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      wave: 3,
      status: "complete",
      scope: "ERP operational mobile responsiveness",
      mobileDataPages: mobileDataPages.length,
      sqlRequired: false,
    },
    null,
    2
  )
);
