#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const read = (file) => fs.readFile(path.join(ROOT, file), "utf8");
const failures = [];

const lazyPages = await read("client/src/lazyPages.ts");
const moduleImports = [
  ...lazyPages.matchAll(/import\(["']@\/pages\/([^"']+)["']\)/g),
].map((match) => match[1]);
const uniqueModules = [...new Set(moduleImports)].sort();

// This counts direct lazy import modules, not routed pages. The 2026-11
// dead-code cleanup retired 28 unused exports (including a sample-data mockup)
// while preserving every live route and underlying hub module. Keep a floor
// below the verified post-cleanup inventory of 190 to catch accidental loss.
const MIN_LAZY_MODULES = 180;
if (uniqueModules.length < MIN_LAZY_MODULES) {
  failures.push(`Lazy module inventory unexpectedly fell to ${uniqueModules.length}; expected at least ${MIN_LAZY_MODULES} modules`);
}

// Only these route tables import the shared lazy-page registry. Add future
// router consumers when they start importing client/src/lazyPages.ts.
// A missing registration is not proof that the underlying page is unused.
const lazyRouteConsumers = [
  "client/src/routes/ErpRoutes.tsx",
  "client/src/routes/PosRoutes.tsx",
  "client/src/components/FactoryRoutes.tsx",
  "client/src/app/PropertiesRoutes.tsx",
];
const runtimeLazyReferences = (await Promise.all(lazyRouteConsumers.map(read))).join("\n");
const lazyExportNames = [...lazyPages.matchAll(/^export const (\w+)\s*=\s*lazy\(/gm)].map((match) => match[1]);
// FactoryWorkersHub is pinned by the lazy-import contract, and its page is
// also used by the payroll hub and offline preload. Keep that export.
const testPinnedLazyExports = new Set(["FactoryWorkersHub"]);
const activeLazyTokens = new Set(runtimeLazyReferences.split(/[^A-Za-z0-9_$]+/));
const unreferencedLazyExports = lazyExportNames.filter(
  (name) => !testPinnedLazyExports.has(name) && !activeLazyTokens.has(name)
);
if (unreferencedLazyExports.length > 0) {
  failures.push(`Unused lazy-page exports without route consumers: ${unreferencedLazyExports.join(", ")}`);
}

for (const modulePath of uniqueModules) {
  const candidates = [
    `client/src/pages/${modulePath}.tsx`,
    `client/src/pages/${modulePath}.ts`,
    `client/src/pages/${modulePath}/index.tsx`,
  ];
  let found = false;
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(ROOT, candidate));
      found = true;
      break;
    } catch {
      // Try the next supported module shape.
    }
  }
  if (!found) failures.push(`Lazy module has no source file: @/pages/${modulePath}`);
}

const shells = [
  { file: "client/src/app/ErpShell.tsx", routeToken: "<Router user={user}" },
  { file: "client/src/app/FactoryShell.tsx", routeToken: "<FactoryRoutes" },
  { file: "client/src/app/PosShell.tsx", routeToken: "<Router user={user}" },
  { file: "client/src/app/PropertiesShell.tsx", routeToken: "<PropertiesRoutes" },
];

for (const { file, routeToken } of shells) {
  const source = await read(file);
  if (!source.includes("WorkspaceRouteBoundary")) failures.push(`${file} is missing WorkspaceRouteBoundary`);
  const boundaryStart = source.indexOf("<WorkspaceRouteBoundary");
  const boundaryEnd = source.indexOf("</WorkspaceRouteBoundary>", boundaryStart);
  const routePosition = source.indexOf(routeToken);
  if (boundaryStart < 0 || boundaryEnd < 0 || routePosition < boundaryStart || routePosition > boundaryEnd) {
    failures.push(`${file} renders its route switch outside the shared UX boundary`);
  }
}

const boundary = await read("client/src/components/ui/workspace-route-boundary.tsx");
for (const token of [
  'data-ux-consistency-boundary="true"',
  "WorkspaceConsistencyBoundary",
  "WorkspaceRouteBoundary",
  "ErrorBoundary",
  "Suspense",
  "LoadingState",
  "max-sm:[&_button]:min-h-11",
  "max-sm:[&_input]:text-base",
  "**:data-table-scroll-region:max-w-full",
  "**:[[role=dialog]]:max-w-[calc(100vw-1rem)]",
]) {
  if (!boundary.includes(token)) failures.push(`Shared UX boundary is missing: ${token}`);
}

for (const forbidden of ["/api/", "useQuery(", "useMutation(", "queryClient", "ledgerAccount", "costPerKg"]) {
  if (boundary.includes(forbidden)) failures.push(`Shared UX boundary contains business logic: ${forbidden}`);
}

const languageProvider = await read("client/src/contexts/ApplicationLanguageContext.tsx");
for (const token of [
  "ApplicationInterfaceTranslator",
  "applyApplicationLanguageToDocument",
  "LiveRegion",
  "APPLICATION_LANGUAGE_EVENT",
]) {
  if (!languageProvider.includes(token)) failures.push(`Global language boundary is missing: ${token}`);
}

const protectedFilterModules = [
  {
    file: "client/src/pages/Daybook.tsx",
    token: "useDaybookFilterState",
    controls: "client/src/pages/daybook/DaybookFilters.tsx",
  },
  {
    file: "client/src/pages/transactionjournal/useTransactionJournalModel.ts",
    token: "usePaginatedFilterState",
    controls: "client/src/pages/transactionjournal/components/JournalFilters.tsx",
  },
  {
    file: "client/src/pages/factory/daybook/useFactoryDaybookModel.ts",
    token: "loadFactoryDaybookState",
    controls: "client/src/pages/factory/daybook/FactoryDaybookFilters.tsx",
  },
  {
    file: "client/src/pages/stockitems/useStockItems.ts",
    token: "useStockItemsFilters",
    controls: "client/src/pages/stockitems/StockItemsView.tsx",
  },
  {
    file: "client/src/pages/Customers.tsx",
    token: "usePaginatedFilterState",
    controls: "client/src/pages/Customers.tsx",
  },
  {
    file: "client/src/pages/Suppliers.tsx",
    token: "useSuppliersFilters",
    controls: "client/src/pages/Suppliers.tsx",
  },
  {
    file: "client/src/pages/StockTransfers.tsx",
    token: "usePaginatedFilterState",
    controls: "client/src/pages/StockTransfers.tsx",
  },
  {
    file: "client/src/pages/pos/POSDaybook.tsx",
    token: "usePaginatedFilterState",
    controls: "client/src/pages/pos/POSDaybook.tsx",
  },
  {
    file: "client/src/pages/pos/POSCustomers.tsx",
    token: "usePaginatedFilterState",
    controls: "client/src/pages/pos/POSCustomers.tsx",
  },
  {
    file: "client/src/pages/factory/FactoryContainers.tsx",
    token: "usePaginatedFilterState",
    controls: "client/src/pages/factory/factory-containers/ContainerListView.tsx",
  },
];
for (const { file, token, controls } of protectedFilterModules) {
  const source = await read(file);
  if (!source.includes(token)) failures.push(`${file} lost its persisted filter-state contract (${token})`);
  const controlSource = controls === file ? source : await read(controls);
  if (!controlSource.includes("button-clear-filters") && !controlSource.includes("button-reset-filters")) {
    failures.push(`${file} lost its reset-all filter control`);
  }
}

const groups = {
  factory: uniqueModules.filter((modulePath) => modulePath.startsWith("factory/")).length,
  pos: uniqueModules.filter((modulePath) => modulePath.startsWith("pos/")).length,
  properties: uniqueModules.filter((modulePath) => modulePath.startsWith("properties/")).length,
  supplierPartner: uniqueModules.filter((modulePath) => modulePath.startsWith("sp/")).length,
};
groups.erp = uniqueModules.length - groups.factory - groups.pos - groups.properties - groups.supplierPartner;

if (failures.length > 0) {
  console.error("Cross-module UX consistency audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      status: "complete",
      lazyModuleSurfaces: uniqueModules.length,
      lazyPageExports: lazyExportNames.length,
      unusedLazyPageExports: unreferencedLazyExports.length,
      workspaceShells: shells.length,
      moduleGroups: groups,
      globalContracts: [
        "responsive containment",
        "mobile touch targets",
        "standard loading and error recovery",
        "dialog and table overflow safety",
        "EN/FR/AR document translation and direction",
      ],
      protectedFilterModules: protectedFilterModules.length,
    },
    null,
    2,
  ),
);

// TEMPORARY PHASE 3 DIAGNOSTIC ONLY: print Prettier's expected source lines.
// This block will be removed before marking the PR ready for merge.
{
  const { default: prettier } = await import("prettier");
  const file = "client/src/components/FactoryRoutes.tsx";
  const source = await read(file);
  const options = (await prettier.resolveConfig(file)) ?? {};
  const formatted = await prettier.format(source, { ...options, filepath: file });
  const originalLines = source.split("\n");
  const formattedLines = formatted.split("\n");
  let firstMismatch = -1;
  for (let i = 0; i < Math.max(originalLines.length, formattedLines.length); i++) {
    if (originalLines[i] !== formattedLines[i]) { firstMismatch = i; break; }
  }
  if (firstMismatch >= 0) {
    console.log("PHASE3_PRETTIER_DIAGNOSTIC", JSON.stringify({
      firstMismatch: firstMismatch + 1,
      actual: originalLines.slice(Math.max(0, firstMismatch - 3), firstMismatch + 10),
      expected: formattedLines.slice(Math.max(0, firstMismatch - 3), firstMismatch + 10),
      actualLines: originalLines.length,
      expectedLines: formattedLines.length
    }));
  } else {
    console.log("PHASE3_PRETTIER_DIAGNOSTIC file already formatted");
  }
}
