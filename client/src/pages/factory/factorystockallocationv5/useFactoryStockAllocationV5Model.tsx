import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { fetchAllV5AllocationData } from "@/lib/v5AllocationPaginationClient";
import { FACTORY_V5_ALLOCATION_BASE } from "@/lib/factoryAllocationReadModel";
import { companyQueryKey } from "@/lib/companyQueryScope";
import type { V5Data, V5Row } from "./types";
import { useFactoryStockAllocationV5DataModel } from "./useFactoryStockAllocationV5DataModel";

function isGarbageOrWipers(row: V5Row) {
  if (row.isGarbageOrWipers) return true;
  const n = row.productName.toLowerCase();
  return n.includes("wiper") || n.includes("garbage");
}

export function useFactoryStockAllocationV5Model() {
  const hs = useFactoryStockAllocationV5DataModel();

  /* ── Cancel-Container dialog state ──────────────────────────────────────── */
  const [cancelDialog, setCancelDialog] = useState<{
    orderId: number;
    containerName: string;
    status: "DRAFT" | "LOADING";
  } | null>(null);
  const [, setCancelSuperUser] = useState("");
  const [, setCancelSuperPass] = useState("");

  const cancelContainerMut = useMutation({
    mutationFn: ({
      orderId,
      supervisorUsername,
      supervisorPassword,
    }: {
      orderId: number;
      supervisorUsername?: string;
      supervisorPassword?: string;
    }) =>
      apiRequest("POST", `/api/factory/customer-orders/${orderId}/cancel`, {
        ...(supervisorUsername ? { supervisorUsername, supervisorPassword } : {}),
      }),
    onSuccess: () => {
      hs.toast({ title: "Container cancelled." });
      setCancelDialog(null);
      setCancelSuperUser("");
      setCancelSuperPass("");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });
    },
    onError: (err: ClientErrorLike) => {
      hs.toast({ title: "Cancel failed", description: err.message ?? "Unknown error", variant: "destructive" });
    },
  });

  /* ── Query ──────────────────────────────────────────────────────────────── */
  const query = useQuery<V5Data>({
    queryKey: companyQueryKey(
      FACTORY_V5_ALLOCATION_BASE,
      hs.selectedCompany?.id,
      hs.hideZero,
      hs.debouncedSearch || undefined
    ),
    enabled: Boolean(hs.selectedCompany?.id),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (hs.hideZero) params.set("hideZero", "true");
      if (hs.debouncedSearch.trim()) params.set("search", hs.debouncedSearch.trim());
      // The overview is a complete, naturally scrolling table. Bypass the legacy
      // 50-row progressive fetch interceptor and allow the server to return all rows.
      params.set("fullAction", "1");
      const res = await fetch(`/api/factory/v5/stock-allocation?${params}`, { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed");
      }
      return res.json();
    },
    retry: 1,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });

  const allRows = useMemo(
    () => (query.data?.rows ?? []).slice().sort((a, b) => a.productName.localeCompare(b.productName)),
    [query.data?.rows]
  );
  const garbageWipersCount = allRows.filter(isGarbageOrWipers).length;
  const rows = useMemo(() => {
    const filteredRows = hs.showGarbageWipers ? allRows : allRows.filter((r) => !isGarbageOrWipers(r));
    const negativeFilteredRows = hs.showNegativeOnly ? filteredRows.filter((r) => r.freeToPromise < 0) : filteredRows;
    const categoryFilteredRows =
      hs.categoryFilter.length > 0
        ? negativeFilteredRows.filter((r) => hs.categoryFilter.includes(r.categoryName ?? ""))
        : negativeFilteredRows;

    if (!hs.searchQuery.trim()) return categoryFilteredRows;
    return categoryFilteredRows.filter((r) => searchAny(hs.searchQuery, r.productName, r.articleCode));
  }, [allRows, hs.categoryFilter, hs.searchQuery, hs.showGarbageWipers, hs.showNegativeOnly]);

  // Unique sorted category names from all loaded rows (unfiltered) for the dropdown
  const allCategories = useMemo(() => {
    const cats = new Set<string>();
    allRows.forEach((r) => {
      if (r.categoryName) cats.add(r.categoryName);
    });
    return Array.from(cats).sort();
  }, [allRows]);
  const totals = query.data?.totals;

  // Auto-expand rows that contain the focused proforma, then scroll to the
  // first match once. Previously `rows` was rebuilt on every render, so this
  // effect repeatedly called scrollIntoView and pulled the user back down while
  // they were trying to scroll upward.
  useEffect(() => {
    if (!hs.focusProformaId) {
      hs.autoScrolledProformaIdRef.current = null;
      hs.firstMatchRef.current = null;
      return;
    }
    if (rows.length === 0 || hs.autoScrolledProformaIdRef.current === hs.focusProformaId) return;

    const toExpand = rows
      .filter((r) => r.proformaDetails.some((p) => p.proformaId === hs.focusProformaId))
      .map((r) => r.articleCode);
    if (toExpand.length === 0) return;

    // Clear any stale target from a previously focused proforma, then mark this
    // focus as handled before the state update can trigger another render.
    hs.firstMatchRef.current = null;
    hs.autoScrolledProformaIdRef.current = hs.focusProformaId;
    hs.setExpandedRows((prev) => {
      const next = new Set(prev);
      toExpand.forEach((c) => next.add(c));
      return next;
    });

    const scrollTimer = window.setTimeout(() => {
      hs.firstMatchRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    return () => window.clearTimeout(scrollTimer);
  }, [hs.focusProformaId, rows]);

  // Preserve older "Edit in Allocation" bookmarked links without opening a popup.
  useEffect(() => {
    if (
      hs.openEditOnLoad &&
      hs.focusProformaId !== null &&
      Number.isSafeInteger(hs.focusProformaId) &&
      hs.focusProformaId > 0
    ) {
      hs.navigate(`/factory/stock-allocation-v5/proformas/${hs.focusProformaId}/edit`, { replace: true });
    }
  }, [hs.openEditOnLoad, hs.focusProformaId, hs.navigate]);

  const handleRefresh = useCallback(() => {
    query.refetch().then(() => {
      hs.setRefreshFlash(true);
      setTimeout(() => hs.setRefreshFlash(false), 1500);
    });
  }, [query]);

  function toggleRow(code: string) {
    hs.setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  /* ── Excel export ────────────────────────────────────────────────────────── */
  async function handleExportExcel() {
    // Export every matching article across pages, not just the visible grid.
    const exportParams = new URLSearchParams();
    if (hs.hideZero) exportParams.set("hideZero", "true");
    if (hs.debouncedSearch.trim()) exportParams.set("search", hs.debouncedSearch.trim());

    let exportRows: V5Row[];
    try {
      const complete = await fetchAllV5AllocationData(exportParams);
      exportRows = complete.rows as V5Row[];
    } catch (error) {
      hs.toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "The complete filtered allocation could not be loaded.",
        variant: "destructive",
      });
      return;
    }
    if (!hs.showGarbageWipers) exportRows = exportRows.filter((row) => !isGarbageOrWipers(row));
    if (hs.showNegativeOnly) exportRows = exportRows.filter((row) => row.freeToPromise < 0);

    const filtered = exportRows.filter((r) => {
      if (r.freeToPromise > 0) return hs.exportIncludePositive;
      if (r.freeToPromise < 0) return hs.exportIncludeNegative;
      return hs.exportIncludeZero;
    });

    const rows = filtered.map((r) => ({
      articleCode: r.articleCode,
      productName: r.productName,
      stockAvailable: r.stockAvailable,
      expectedToLoad: r.expectedToLoad,
      totalLoaded: r.totalLoaded,
      freeToPromise: r.freeToPromise,
    }));
    const totals = {
      articleCode: "TOTALS",
      productName: filtered.length + " products",
      stockAvailable: filtered.reduce((s, r) => s + r.stockAvailable, 0),
      expectedToLoad: filtered.reduce((s, r) => s + r.expectedToLoad, 0),
      totalLoaded: filtered.reduce((s, r) => s + r.totalLoaded, 0),
      freeToPromise: filtered.reduce((s, r) => s + r.freeToPromise, 0),
    };
    const now = new Date();
    const stamp =
      String(now.getFullYear()) + String(now.getMonth() + 1).padStart(2, "0") + String(now.getDate()).padStart(2, "0");
    try {
      const { buildUniversalExcelWorkbook } = await import("@shared/universal-excel/engine");
      const { writeFile } = await import("@/lib/excelHelper");
      const { workbook } = buildUniversalExcelWorkbook({
        schemaVersion: 1,
        mode: "report",
        title: "Factory Stock Allocation",
        filters: [
          { label: "Search", value: hs.debouncedSearch.trim() || "All" },
          { label: "Include positive", value: String(hs.exportIncludePositive) },
          { label: "Include negative", value: String(hs.exportIncludeNegative) },
          { label: "Include zero", value: String(hs.exportIncludeZero) },
          { label: "Include garbage/wipers", value: String(hs.showGarbageWipers) },
        ],
        sheets: [
          {
            kind: "table",
            name: "Stock Allocation",
            columns: [
              { key: "articleCode", header: "Article Code", width: 16 },
              { key: "productName", header: "Product Name", width: 36 },
              { key: "stockAvailable", header: "Stock Available", type: "decimal", width: 16 },
              { key: "expectedToLoad", header: "Expected to Load", type: "decimal", width: 18 },
              { key: "totalLoaded", header: "Total Loaded", type: "decimal", width: 14 },
              { key: "freeToPromise", header: "Available Balance", type: "decimal", width: 18 },
            ],
            rows,
            footer: totals,
          },
        ],
      });
      // Retain the legacy red/green meaning for available balance. Header,
      // filters and export design come from the universal workbook builder.
      const worksheet = workbook.getWorksheet("Stock Allocation")!;
      rows.forEach((row, i) => {
        const cell = worksheet.getRow(i + 6).getCell(6);
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: row.freeToPromise > 0 ? "FFDCFCE7" : row.freeToPromise < 0 ? "FFFEE2E2" : "FFF1F5F9" },
        };
        cell.font = {
          name: "Aptos",
          color: { argb: row.freeToPromise > 0 ? "FF15803D" : row.freeToPromise < 0 ? "FFDC2626" : "FF64748B" },
        };
      });
      await writeFile(workbook, "stock_allocation_" + stamp + ".xlsx");
    } catch (error: unknown) {
      hs.toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Could not export stock allocation",
        variant: "destructive",
      });
      return;
    }
    hs.setExportDialogOpen(false);
  }

  /* ── Category multi-select helpers ───────────────────────────────────── */
  const [catDropOpen, setCatDropOpen] = useState(false);
  const catDropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (catDropRef.current && !catDropRef.current.contains(e.target as Node)) setCatDropOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);
  function toggleCategory(cat: string) {
    hs.setCategoryFilter((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  }
  const catLabel =
    hs.categoryFilter.length === 0
      ? "All Categories"
      : hs.categoryFilter.length === 1
        ? hs.categoryFilter[0]
        : `${hs.categoryFilter.length} categories`;

  return {
    focusProformaId: hs.focusProformaId,
    firstMatchRef: hs.firstMatchRef,
    createDrawerOpen: hs.createDrawerOpen,
    setCreateDrawerOpen: hs.setCreateDrawerOpen,
    expandedRows: hs.expandedRows,
    hideZero: hs.hideZero,
    setHideZero: hs.setHideZero,
    showNegativeOnly: hs.showNegativeOnly,
    setShowNegativeOnly: hs.setShowNegativeOnly,
    showGarbageWipers: hs.showGarbageWipers,
    setShowGarbageWipers: hs.setShowGarbageWipers,
    refreshFlash: hs.refreshFlash,
    searchQuery: hs.searchQuery,
    setSearchQuery: hs.setSearchQuery,
    categoryFilter: hs.categoryFilter,
    setCategoryFilter: hs.setCategoryFilter,
    exportDialogOpen: hs.exportDialogOpen,
    setExportDialogOpen: hs.setExportDialogOpen,
    exportIncludePositive: hs.exportIncludePositive,
    setExportIncludePositive: hs.setExportIncludePositive,
    exportIncludeNegative: hs.exportIncludeNegative,
    setExportIncludeNegative: hs.setExportIncludeNegative,
    exportIncludeZero: hs.exportIncludeZero,
    setExportIncludeZero: hs.setExportIncludeZero,
    addCtDialog: hs.addCtDialog,
    setAddCtDialog: hs.setAddCtDialog,
    ctCount: hs.ctCount,
    ctNames: hs.ctNames,
    openAddContainers: hs.openAddContainers,
    handleCtCountChange: hs.handleCtCountChange,
    handleCtNameChange: hs.handleCtNameChange,
    addContainersMut: hs.addContainersMut,
    submitAddContainers: hs.submitAddContainers,
    closeDialog: hs.closeDialog,
    setCloseDialog: hs.setCloseDialog,
    closeProformaMut: hs.closeProformaMut,
    editDraftDialog: hs.editDraftDialog,
    setEditDraftDialog: hs.setEditDraftDialog,
    editDraftQtys: hs.editDraftQtys,
    setEditDraftQtys: hs.setEditDraftQtys,
    openEditDraft: hs.openEditDraft,
    editDraftMut: hs.editDraftMut,
    submitEditDraft: hs.submitEditDraft,
    linkDialog: hs.linkDialog,
    setLinkDialog: hs.setLinkDialog,
    linkSelected: hs.linkSelected,
    setLinkSelected: hs.setLinkSelected,
    unlinkedQuery: hs.unlinkedQuery,
    linkMut: hs.linkMut,
    restoreDialogOpen: hs.restoreDialogOpen,
    setRestoreDialogOpen: hs.setRestoreDialogOpen,
    cancelledContainersQuery: hs.cancelledContainersQuery,
    restoreContainerMut: hs.restoreContainerMut,
    cancelDialog,
    setCancelDialog,
    setCancelSuperUser,
    setCancelSuperPass,
    cancelContainerMut,
    query,
    garbageWipersCount,
    rows,
    allCategories,
    totals,
    handleRefresh,
    toggleRow,
    handleExportExcel,
    catDropOpen,
    setCatDropOpen,
    catDropRef,
    toggleCategory,
    catLabel,
  } as const;
}
