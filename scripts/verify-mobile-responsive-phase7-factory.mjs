#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");

const factoryMobile = await read("client/src/components/ui/factory-mobile.tsx");
const factoryShell = await read("client/src/app/FactoryShell.tsx");
const stockEntry = await read("client/src/pages/factory/BaleStockEntry.tsx");
const dailySummary = await read("client/src/pages/factory/bale-stock-entry/DailyStockSummary.tsx");
const scanner = await read("client/src/pages/factory/bale-stock-entry/StockEntryScanner.tsx");
const cart = await read("client/src/pages/factory/bale-stock-entry/StockEntryCart.tsx");
const sidebar = await read("client/src/pages/factory/bale-stock-entry/StockEntrySidebar.tsx");
const failures = [];

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
]) {
  if (!factoryMobile.includes(token)) failures.push(`Factory mobile primitive missing: ${token}`);
}

for (const token of [
  'data-factory-workspace="true"',
  "factoryWorkspaceClasses",
  "max-sm:[&_button]:min-h-11",
  "max-sm:[&_input]:min-h-11",
  "max-sm:[&_input]:text-base",
  "[&_form]:max-w-full",
  "**:data-mobile-data-list:max-w-full",
]) {
  if (!factoryShell.includes(token)) failures.push(`Factory workspace contract missing: ${token}`);
}

for (const token of [
  "FactoryMobilePage",
  "FactoryMobileHeaderActions",
  'aria-label="Bale stock entry sections"',
  'data-testid="tab-stock-entry"',
  'data-testid="tab-ground-scan"',
]) {
  if (!stockEntry.includes(token)) failures.push(`Bale stock entry page contract missing: ${token}`);
}

for (const token of [
  'data-factory-daily-summary="true"',
  "min-[420px]:grid-cols-2",
  "/api/factory/bales/daily-summary",
]) {
  if (!dailySummary.includes(token)) failures.push(`Factory summary contract missing: ${token}`);
}

for (const token of [
  "FactoryMobileScannerPanel",
  'role="combobox"',
  'aria-autocomplete="list"',
  "aria-activedescendant",
  'role="listbox"',
  'role="option"',
  'type="button"',
  'enterKeyHint="done"',
  "max-sm:relative",
  "FactoryMobileStatus",
]) {
  if (!scanner.includes(token)) failures.push(`Factory scanner contract missing: ${token}`);
}

for (const token of [
  "ResponsiveDataList",
  "ResponsiveDataListField",
  "ResponsiveDataListActions",
  'className="md:hidden"',
  'className="hidden overflow-hidden rounded-xl border bg-card/50 md:block"',
  'scrollLabel="Bales ready for stock entry"',
  'minimumWidth="56rem"',
  'inputMode="numeric"',
  'inputMode="decimal"',
]) {
  if (!cart.includes(token)) failures.push(`Factory cart contract missing: ${token}`);
}

for (const token of [
  "FactoryMobileActionBar",
  'data-testid="button-confirm-stock-entry"',
  "xl:sticky xl:top-6",
]) {
  if (!sidebar.includes(token)) failures.push(`Factory confirmation contract missing: ${token}`);
}

for (const forbidden of [
  "useMutation(",
  "queryClient",
  "adjustInventory",
  "costPerKg",
  "ledgerAccount",
  'fetch("/api/',
]) {
  if (factoryMobile.includes(forbidden)) failures.push(`Shared Factory primitive contains business logic: ${forbidden}`);
}

if (failures.length) {
  console.error("Mobile responsiveness Phase 7 verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      phase: 7,
      status: "implemented",
      protectedContracts: 51,
      sqlRequired: false,
    },
    null,
    2
  )
);
