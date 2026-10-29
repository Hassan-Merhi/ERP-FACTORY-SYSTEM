import type { Plugin } from "vite";

import { heavyListPaginationPlugin as legacyHeavyListPaginationPlugin } from "./viteHeavyListPaginationPluginLegacy.ts";

const STOCK_ENTRY_SUFFIX = "/client/src/pages/StockEntryHistory.tsx";
const FACTORY_DAYBOOK_SHELL_SUFFIX = "/client/src/pages/factory/FactoryDaybook.tsx";
const FACTORY_DAYBOOK_MODEL_SUFFIX = "/client/src/pages/factory/daybook/useFactoryDaybookModel.ts";
const V5_ALLOCATION_SHELL_SUFFIX = "/client/src/pages/factory/FactoryStockAllocationV5.tsx";
const V5_ALLOCATION_MODEL_SUFFIX =
  "/client/src/pages/factory/factorystockallocationv5/useFactoryStockAllocationV5Model.tsx";
const V5_ALLOCATION_COMPONENT_SEGMENT =
  "/client/src/pages/factory/factorystockallocationv5/components/";

function replaceExactly(source: string, before: string, after: string, label: string): string {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`[heavy-list-pagination] Missing transform target: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[heavy-list-pagination] Ambiguous transform target: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function transformStockEntryShell(source: string): string {
  // The current StockEntryHistory page performs a direct paged query and already
  // forwards its search/date filters to the API. The older condensed view used
  // per-group lazy queries, which still need this compatibility patch when that
  // legacy shape is present.
  const before = `      if (group.erpLocationId) gp.set("locationId", String(group.erpLocationId));\n      return {`;
  const first = source.indexOf(before);

  if (first < 0) {
    const directPagedSearch =
      'if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());';
    const currentPagedSearch =
      'const activeSearch = debouncedSearch.trim();';
    const currentLazyGroupFilters =
      source.includes('const expandedGroupBaleKeys = useMemo(') &&
      source.includes('groupParams.set("search", debouncedSearch.trim());');

    // Newer StockEntryHistory owns both the top-level paged search and the
    // expanded-group lazy filter directly. Treat either fully-applied shape as
    // already transformed so the production build stays idempotent.
    if (
      source.includes(directPagedSearch) ||
      (source.includes(currentPagedSearch) && currentLazyGroupFilters)
    ) {
      return source;
    }

    throw new Error(
      "[heavy-list-pagination] Missing transform target: stock-entry lazy expanded group filters"
    );
  }

  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(
      "[heavy-list-pagination] Ambiguous transform target: stock-entry lazy expanded group filters"
    );
  }

  const after = `      if (group.erpLocationId) gp.set("locationId", String(group.erpLocationId));\n      if (statusFilter.length > 0) gp.set("status", statusFilter.join(","));\n      if (debouncedSearch.trim()) gp.set("search", debouncedSearch.trim());\n      return {`;
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function transformFactoryDaybookModel(source: string): string {
  let code = source;

  code = replaceExactly(
    code,
    `import { queryClient } from "@/lib/queryClient";`,
    `import { queryClient } from "@/lib/queryClient";\nimport { fetchAllDaybookEntries } from "@/lib/daybookPaginationClient";`,
    "Factory Daybook full-data helper import"
  );

  code = replaceExactly(
    code,
    `  // Always send startDate/endDate explicitly — including as empty strings for the\n  // "All Time" preset — so the server can tell "user explicitly wants all time" apart\n  // from "caller omitted the params entirely" (e.g. a raw API call) and only applies\n  // its own safety-net default in the latter case.\n  queryParams.set("startDate", startDate || "");\n  queryParams.set("endDate", endDate || "");`,
    `  // Empty values are intentional: their presence prevents the paged backend\n  // from applying its today-only default when the UI selects All Time.\n  queryParams.set("startDate", startDate);\n  queryParams.set("endDate", endDate);`,
    "Factory Daybook All Time date parameters"
  );

  code = replaceExactly(
    code,
    `  if (txTypeFilter !== "ALL") queryParams.set("txType", txTypeFilter);\n  if (currencyFilter !== "ALL") queryParams.set("currencyCode", currencyFilter);`,
    `  if (txTypeFilter !== "ALL") queryParams.set("txType", txTypeFilter);\n  if (currencyFilter !== "ALL") queryParams.set("currencyCode", currencyFilter);\n  if (statusFilter !== "all") queryParams.set("optionalStatus", statusFilter);\n  if (debouncedSearchQuery.trim()) queryParams.set("search", debouncedSearchQuery.trim());\n  if (minAmount.trim()) queryParams.set("minAmount", minAmount.trim());\n  if (maxAmount.trim()) queryParams.set("maxAmount", maxAmount.trim());\n  queryParams.set("sortOrder", sortOrder);`,
    "Factory Daybook server filter parameters"
  );

  code = replaceExactly(
    code,
    `    queryKey: ["/api/factory/daybook", startDate, endDate, txTypeFilter, currencyFilter],`,
    `    queryKey: [\n      "/api/factory/daybook",\n      startDate,\n      endDate,\n      txTypeFilter,\n      currencyFilter,\n      statusFilter,\n      debouncedSearchQuery,\n      minAmount,\n      maxAmount,\n      sortOrder,\n    ],`,
    "Factory Daybook paged query key"
  );

  code = replaceExactly(
    code,
    `  const handleExportToExcel = async () => {\n    if (filteredEntries.length === 0) {\n      warnNothingToExport();\n      return;\n    }\n    const { fileName, rowCount } = await exportFactoryDaybookSummary(filteredEntries, formatDisplayDate);`,
    `  const handleExportToExcel = async () => {\n    let exportEntries: DaybookEntry[];\n    try {\n      exportEntries = (await fetchAllDaybookEntries(new URLSearchParams(queryParams))).filter(\n        (entry) => entry.txType !== "WORKER_EDITED"\n      ) as DaybookEntry[];\n    } catch (error) {\n      toast({\n        title: "Export failed",\n        description:\n          error instanceof Error ? error.message : "The complete filtered daybook could not be loaded.",\n        variant: "destructive",\n      });\n      return;\n    }\n    if (exportEntries.length === 0) {\n      warnNothingToExport();\n      return;\n    }\n    const { fileName, rowCount } = await exportFactoryDaybookSummary(exportEntries, formatDisplayDate);`,
    "Factory Daybook complete summary export"
  );

  code = replaceExactly(
    code,
    `  const handleExportDetailedToExcel = async () => {\n    if (filteredEntries.length === 0) {\n      warnNothingToExport();\n      return;\n    }\n    setIsExportingDetailed(true);\n    try {\n      const { fileName, rowCount } = await exportFactoryDaybookDetailed(filteredEntries, formatDisplayDate);`,
    `  const handleExportDetailedToExcel = async () => {\n    setIsExportingDetailed(true);\n    try {\n      const exportEntries = (await fetchAllDaybookEntries(new URLSearchParams(queryParams))).filter(\n        (entry) => entry.txType !== "WORKER_EDITED"\n      ) as DaybookEntry[];\n      if (exportEntries.length === 0) {\n        warnNothingToExport();\n        return;\n      }\n      const { fileName, rowCount } = await exportFactoryDaybookDetailed(exportEntries, formatDisplayDate);`,
    "Factory Daybook complete detailed export"
  );

  return code;
}

export function heavyListPaginationPlugin(): Plugin {
  const legacy = legacyHeavyListPaginationPlugin();
  const legacyTransform = legacy.transform;

  return {
    ...legacy,
    transform(source, id) {
      const normalizedId = id.replaceAll("\\", "/").split("?")[0];
      if (normalizedId.endsWith(STOCK_ENTRY_SUFFIX)) {
        return { code: transformStockEntryShell(source), map: null };
      }
      if (normalizedId.endsWith(FACTORY_DAYBOOK_MODEL_SUFFIX)) {
        return { code: transformFactoryDaybookModel(source), map: null };
      }
      // V5 now implements full-catalog edit/draft/export actions natively.
      // The legacy build-time drawer patches would reintroduce removed popup
      // state and fail on the dedicated Edit Proforma route.
      if (
        normalizedId.endsWith(V5_ALLOCATION_MODEL_SUFFIX) ||
        normalizedId.endsWith(V5_ALLOCATION_SHELL_SUFFIX) ||
        normalizedId.includes(V5_ALLOCATION_COMPONENT_SEGMENT)
      ) {
        return null;
      }
      if (normalizedId.endsWith(FACTORY_DAYBOOK_SHELL_SUFFIX)) {
        return null;
      }
      if (typeof legacyTransform !== "function") {
        throw new Error("[heavy-list-pagination] Expected legacy transform hook to be callable");
      }
      return legacyTransform.call(this, source, id);
    },
  };
}
