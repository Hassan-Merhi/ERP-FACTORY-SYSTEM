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

function replaceIfPresent(
  source: string,
  before: string,
  after: string,
  label: string,
  seen: Set<string>
): string {
  const first = source.indexOf(before);
  if (first < 0) return source;
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[heavy-list-pagination] Ambiguous transform target: ${label}`);
  }
  seen.add(label);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function transformStockEntryShell(source: string): string {
  const before = `      if (group.erpLocationId) gp.set("locationId", String(group.erpLocationId));\n      return {`;
  const after = `      if (group.erpLocationId) gp.set("locationId", String(group.erpLocationId));\n      if (statusFilter.length > 0) gp.set("status", statusFilter.join(","));\n      if (debouncedSearch.trim()) gp.set("search", debouncedSearch.trim());\n      return {`;
  return replaceExactly(source, before, after, "stock-entry lazy expanded group filters");
}

function transformV5AllocationModel(source: string): string {
  let code = source;

  code = replaceExactly(
    code,
    `import { apiRequest, queryClient } from "@/lib/queryClient";`,
    `import { apiRequest, queryClient } from "@/lib/queryClient";\nimport { fetchAllV5AllocationData } from "@/lib/v5AllocationPaginationClient";`,
    "V5 model full-data helper import"
  );

  code = replaceExactly(
    code,
    `  const [exportDialogOpen, setExportDialogOpen] = useState(false);\n  const [exportIncludePositive, setExportIncludePositive] = useState(true);\n  const [exportIncludeNegative, setExportIncludeNegative] = useState(true);\n  const [exportIncludeZero, setExportIncludeZero] = useState(false);`,
    `  const [exportDialogOpen, setExportDialogOpen] = useState(false);\n  const [exportIncludePositive, setExportIncludePositive] = useState(true);\n  const [exportIncludeNegative, setExportIncludeNegative] = useState(true);\n  const [exportIncludeZero, setExportIncludeZero] = useState(false);\n  const [actionRows, setActionRows] = useState<V5Row[] | null>(null);\n  const [isLoadingActionRows, setIsLoadingActionRows] = useState(false);\n\n  const loadAllActionRows = useCallback(async (): Promise<V5Row[]> => {\n    if (actionRows) return actionRows;\n    setIsLoadingActionRows(true);\n    try {\n      const data = await fetchAllV5AllocationData(new URLSearchParams());\n      const completeRows = data.rows as V5Row[];\n      setActionRows(completeRows);\n      return completeRows;\n    } catch (error: any) {\n      toast({\n        title: "Unable to load all products",\n        description: error?.message || "The complete stock allocation list could not be loaded.",\n        variant: "destructive",\n      });\n      return [];\n    } finally {\n      setIsLoadingActionRows(false);\n    }\n  }, [actionRows, toast]);\n\n  const openCreateDrawerWithAllRows = useCallback(async () => {\n    const completeRows = await loadAllActionRows();\n    if (completeRows.length > 0) setCreateDrawerOpen(true);\n  }, [loadAllActionRows]);\n\n  const openEditDrawerWithAllRows = useCallback(\n    async (proformaId: number) => {\n      const completeRows = await loadAllActionRows();\n      if (completeRows.length > 0) setEditDrawerProformaId(proformaId);\n    },\n    [loadAllActionRows]\n  );`,
    "V5 model full-data action state"
  );

  code = replaceExactly(
    code,
    `  function openEditDraft(proformaId: number, proformaName: string, currentRows: V5Row[]) {\n    const articles: EditDraftArticle[] = [];`,
    `  async function openEditDraft(proformaId: number, proformaName: string, _currentRows: V5Row[]) {\n    const currentRows = actionRows ?? (await loadAllActionRows());\n    if (currentRows.length === 0) return;\n    const articles: EditDraftArticle[] = [];`,
    "V5 model draft quantity full rows"
  );

  code = replaceExactly(
    code,
    `      setEditDraftDialog(null);\n      queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });`,
    `      setEditDraftDialog(null);\n      setActionRows(null);\n      queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });`,
    "V5 model draft save cleanup"
  );

  code = replaceExactly(
    code,
    `    editOpenedRef.current = true;\n    setEditDrawerProformaId(focusProformaId);`,
    `    editOpenedRef.current = true;\n    void openEditDrawerWithAllRows(focusProformaId);`,
    "V5 model focused proforma edit drawer"
  );

  code = replaceExactly(
    code,
    `    const filtered = rows.filter((r) => {`,
    `    const exportParams = new URLSearchParams();\n    if (hideZero) exportParams.set("hideZero", "true");\n    if (debouncedSearch.trim()) exportParams.set("search", debouncedSearch.trim());\n\n    let exportRows: V5Row[];\n    try {\n      const complete = await fetchAllV5AllocationData(exportParams);\n      exportRows = complete.rows as V5Row[];\n    } catch (error: any) {\n      toast({\n        title: "Export failed",\n        description: error?.message || "The complete filtered allocation could not be loaded.",\n        variant: "destructive",\n      });\n      return;\n    }\n\n    if (!showGarbageWipers) exportRows = exportRows.filter((row) => !isGarbageOrWipers(row));\n    if (showNegativeOnly) exportRows = exportRows.filter((row) => row.freeToPromise < 0);\n\n    const filtered = exportRows.filter((r) => {`,
    "V5 model complete Excel export rows"
  );

  code = replaceExactly(
    code,
    `  const drawerRows = useMemo(\n    () =>\n      allRows.map((r) => ({`,
    `  const drawerRows = useMemo(\n    () =>\n      (actionRows ?? allRows).map((r) => ({`,
    "V5 model drawer full row source"
  );

  code = replaceExactly(
    code,
    `    [allRows]\n  );`,
    `    [actionRows, allRows]\n  );`,
    "V5 model drawer row dependencies"
  );

  const returnMatch = /return \{([^}]*)\} as const;/s.exec(code);
  if (!returnMatch) {
    throw new Error("[heavy-list-pagination] Missing transform target: V5 model return object");
  }
  const additions = [
    "actionRows",
    "setActionRows",
    "isLoadingActionRows",
    "openCreateDrawerWithAllRows",
    "openEditDrawerWithAllRows",
  ];
  const existing = returnMatch[1].trimEnd();
  const missing = additions.filter((name) => !new RegExp(`\\b${name}\\b`).test(existing));
  const separator = existing.trim() && !existing.trimEnd().endsWith(",") ? "," : "";
  code =
    code.slice(0, returnMatch.index) +
    `return {${existing}${separator}${missing.length ? ` ${missing.join(", ")}` : ""} } as const;` +
    code.slice(returnMatch.index + returnMatch[0].length);

  return code;
}

function transformV5AllocationPresentation(source: string, seen: Set<string>): string {
  let code = source;

  code = replaceIfPresent(
    code,
    `          <Button size="sm" onClick={() => setCreateDrawerOpen(true)} data-testid="button-v5-open-create-proforma">`,
    `          <Button\n            size="sm"\n            onClick={() => void model.openCreateDrawerWithAllRows()}\n            disabled={model.isLoadingActionRows}\n            data-testid="button-v5-open-create-proforma"\n          >`,
    "V5 create drawer full-data opener",
    seen
  );

  code = replaceIfPresent(
    code,
    `                                    onClick={() => setEditDrawerProformaId(proforma.proformaId)}`,
    `                                    onClick={() => void model.openEditDrawerWithAllRows(proforma.proformaId)}`,
    "V5 edit drawer full-data opener",
    seen
  );

  code = replaceIfPresent(
    code,
    `        onClose={() => setCreateDrawerOpen(false)}\n        articleRows={drawerRows}\n        onSuccess={() => query.refetch()}`,
    `        onClose={() => {\n          setCreateDrawerOpen(false);\n          model.setActionRows(null);\n        }}\n        articleRows={drawerRows}\n        onSuccess={() => {\n          model.setActionRows(null);\n          query.refetch();\n        }}`,
    "V5 create drawer cleanup",
    seen
  );

  code = replaceIfPresent(
    code,
    `          onClose={() => setEditDrawerProformaId(null)}\n          proformaId={editDrawerProformaId}\n          articleRows={drawerRows}\n          onSuccess={() => query.refetch()}`,
    `          onClose={() => {\n            setEditDrawerProformaId(null);\n            model.setActionRows(null);\n          }}\n          proformaId={editDrawerProformaId}\n          articleRows={drawerRows}\n          onSuccess={() => {\n            model.setActionRows(null);\n            query.refetch();\n          }}`,
    "V5 edit drawer cleanup",
    seen
  );

  code = replaceIfPresent(
    code,
    `        onOpenChange={(open) => {\n          if (!open) setEditDraftDialog(null);\n        }}`,
    `        onOpenChange={(open) => {\n          if (!open) {\n            setEditDraftDialog(null);\n            model.setActionRows(null);\n          }\n        }}`,
    "V5 draft dialog cleanup",
    seen
  );

  if (!seen.has("V5 draft dialog cleanup")) {
    const compactDraftCleanup = "if (!open) setEditDraftDialog(null);";
    const first = code.indexOf(compactDraftCleanup);
    if (first >= 0) {
      if (code.indexOf(compactDraftCleanup, first + compactDraftCleanup.length) >= 0) {
        throw new Error("[heavy-list-pagination] Ambiguous transform target: V5 draft dialog cleanup");
      }
      code =
        code.slice(0, first) +
        "if (!open) { setEditDraftDialog(null); model.setActionRows(null); }" +
        code.slice(first + compactDraftCleanup.length);
      seen.add("V5 draft dialog cleanup");
    }
  }

  return code;
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
  const legacyBuildEnd = legacy.buildEnd;
  const v5PresentationSeen = new Set<string>();
  const expectedV5PresentationPatches = [
    "V5 create drawer full-data opener",
    "V5 edit drawer full-data opener",
    "V5 create drawer cleanup",
    "V5 edit drawer cleanup",
    "V5 draft dialog cleanup",
  ];

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
      if (normalizedId.endsWith(V5_ALLOCATION_MODEL_SUFFIX)) {
        return { code: transformV5AllocationModel(source), map: null };
      }
      if (
        normalizedId.endsWith(V5_ALLOCATION_SHELL_SUFFIX) ||
        normalizedId.includes(V5_ALLOCATION_COMPONENT_SEGMENT)
      ) {
        const code = transformV5AllocationPresentation(source, v5PresentationSeen);
        return code === source ? null : { code, map: null };
      }
      if (normalizedId.endsWith(FACTORY_DAYBOOK_SHELL_SUFFIX)) {
        return null;
      }
      if (typeof legacyTransform !== "function") {
        throw new Error("[heavy-list-pagination] Expected legacy transform hook to be callable");
      }
      return legacyTransform.call(this, source, id);
    },
    async buildEnd(error) {
      if (!error) {
        const missing = expectedV5PresentationPatches.filter(
          (label) => !v5PresentationSeen.has(label)
        );
        if (missing.length > 0) {
          throw new Error(
            `[heavy-list-pagination] Missing split V5 presentation transform target(s): ${missing.join(", ")}`
          );
        }
      }
      if (typeof legacyBuildEnd === "function") {
        await legacyBuildEnd.call(this, error);
      }
    },
  };
}
