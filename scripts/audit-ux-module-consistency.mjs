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

if (uniqueModules.length < 200) {
  failures.push(`Lazy module inventory unexpectedly fell to ${uniqueModules.length}; expected at least 200 routed surfaces`);
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
