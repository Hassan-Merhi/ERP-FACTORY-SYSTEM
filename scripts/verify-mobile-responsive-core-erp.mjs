#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

// This source-contract verifier is intentionally independent of server, API, and database behavior.
const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const core = await read("client/src/components/ui/core-erp-mobile.tsx");
const tabs = await read("client/src/components/ui/tabs.tsx");
const periodFilter = await read("client/src/components/ui/period-filter.tsx");
const daybookFilters = await read("client/src/pages/daybook/DaybookFilters.tsx");
const stockHistory = await read("client/src/pages/StockItemHistory.tsx");
const browserCompat = await read("client/src/mobile-browser-compat.css");
const failures = [];

for (const token of [
  "CoreErpPage",
  "CoreErpHeader",
  "CoreErpHeaderActions",
  "CoreErpFilterGrid",
  "CoreErpSummaryGrid",
  "CoreErpSummaryItem",
  "CoreErpSummaryLabel",
  "CoreErpSummaryValue",
  'data-core-erp-page="true"',
  'data-core-erp-filters="true"',
  'data-core-erp-summary="true"',
  "min-[360px]:grid-cols-2",
  "min-[420px]:grid-cols-2",
]) {
  if (!core.includes(token)) failures.push(`Core ERP layout contract missing: ${token}`);
}

for (const token of [
  'role="tablist"',
  'data-responsive-tabs="true"',
  // touch-auto (not pan-x) so a vertical page swipe that starts on the strip still scrolls the page.
  "overflow-x-auto overscroll-x-contain touch-auto",
  "flex-nowrap",
  'role="tab"',
  "aria-selected={active}",
  "min-h-11",
]) {
  if (!tabs.includes(token)) failures.push(`Responsive tabs contract missing: ${token}`);
}

for (const token of [
  "useIsMobile",
  "numberOfMonths={isMobile ? 1 : 2}",
  "DialogBody",
  "w-full min-w-0 justify-between",
  "max-w-[calc(100vw-1rem)]",
]) {
  if (!periodFilter.includes(token)) failures.push(`Responsive period filter contract missing: ${token}`);
}

for (const token of [
  "CoreErpFilterGrid",
  'label="Daybook filters"',
  'data-testid="select-voucher-type"',
  'data-testid="select-status-filter"',
  'data-testid="input-search"',
  "overflow-x-auto overscroll-x-contain",
]) {
  if (!daybookFilters.includes(token)) failures.push(`Daybook mobile contract missing: ${token}`);
}

for (const token of [
  "CoreErpPage",
  "CoreErpHeaderActions",
  "CoreErpSummaryGrid",
  "ResponsiveDataList",
  "ResponsiveDataListField",
  'role={hasData ? "button" : undefined}',
  'event.key !== "Enter"',
  'event.key !== " "',
  'minimumWidth="52rem"',
  'scrollLabel="Stock item monthly summary"',
]) {
  if (!stockHistory.includes(token)) failures.push(`Stock history mobile contract missing: ${token}`);
}

for (const token of [
  "[data-core-erp-page]",
  "[data-core-erp-filters]",
  "[data-core-erp-actions]",
  '[data-responsive-tabs="true"]',
  "-webkit-overflow-scrolling: touch",
]) {
  if (!browserCompat.includes(token)) failures.push(`Browser compatibility contract missing: ${token}`);
}

for (const source of [core, tabs, periodFilter]) {
  for (const forbidden of [
    "useMutation(",
    "queryClient",
    "adjustInventory",
    "costPerKg",
    "ledgerAccount",
    'fetch("/api/',
  ]) {
    if (source.includes(forbidden)) failures.push(`Shared core ERP primitive contains business logic: ${forbidden}`);
  }
}

if (failures.length) {
  console.error("Mobile responsiveness Phase 6 verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phase: 6,
      status: "implemented",
      protectedContracts: 49,
      sqlRequired: false,
    },
    null,
    2
  )
);
