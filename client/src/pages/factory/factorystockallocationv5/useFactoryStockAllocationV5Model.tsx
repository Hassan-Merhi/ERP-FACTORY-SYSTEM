import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { V5Data, V5Row } from "./types";

export function useFactoryStockAllocationV5Model() {
  const { toast } = useToast();
  const searchString = useSearch();
  const focusProformaId = useMemo(() => {
    const p = new URLSearchParams(searchString).get("proformaId");
    return p ? parseInt(p) : null;
  }, [searchString]);

  const openEditOnLoad = useMemo(() => {
    return new URLSearchParams(searchString).get("openEdit") === "true";
  }, [searchString]);

  const firstMatchRef = useRef<HTMLTableRowElement | null>(null);

  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [editDrawerProformaId, setEditDrawerProformaId] = useState<number | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [hideZero, setHideZero] = useState(true);
  const [showNegativeOnly, setShowNegativeOnly] = useState(false);
  const [showGarbageWipers, setShowGarbageWipers] = useState(false);
  const [refreshFlash, setRefreshFlash] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  // Debounced value sent to the server — prevents one request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  /* ── Export dialog state ─────────────────────────────────────────────────── */
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportIncludePositive, setExportIncludePositive] = useState(true);
  const [exportIncludeNegative, setExportIncludeNegative] = useState(true);
  const [exportIncludeZero, setExportIncludeZero] = useState(false);

  /* ── Add-Containers dialog state ────────────────────────────────────────── */
  const [addCtDialog, setAddCtDialog] = useState<{
    proformaId: number;
    proformaName: string;
    existingCount: number;
  } | null>(null);
  const [ctCount, setCtCount] = useState(1);
  const [ctNames, setCtNames] = useState<string[]>([]);

  function openAddContainers(proformaId: number, proformaName: string, existingCount: number) {
    setAddCtDialog({ proformaId, proformaName, existingCount });
    setCtCount(1);
    setCtNames([`Container ${existingCount + 1}`]);
  }

  function handleCtCountChange(val: number) {
    const n = Math.max(1, Math.min(50, val || 1));
    setCtCount(n);
    setCtNames((prev) => {
      const base = addCtDialog?.existingCount ?? 0;
      if (n > prev.length) {
        const extra = Array.from({ length: n - prev.length }, (_, i) => `Container ${base + prev.length + i + 1}`);
        return [...prev, ...extra];
      }
      return prev.slice(0, n);
    });
  }

  function handleCtNameChange(idx: number, val: string) {
    setCtNames((prev) => prev.map((n, i) => (i === idx ? val : n)));
  }

  const addContainersMut = useMutation({
    mutationFn: ({ proformaId, names }: { proformaId: number; names: string[] }) =>
      apiRequest("POST", `/api/factory/v5/proforma/${proformaId}/add-containers`, { containerNames: names }),
    onSuccess: (_data, { names }) => {
      toast({ title: `Added ${names.length} container${names.length !== 1 ? "s" : ""}.` });
      setAddCtDialog(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error adding containers", description: err.message ?? "Unknown error", variant: "destructive" });
    },
  });

  function submitAddContainers() {
    if (!addCtDialog) return;
    const trimmed = ctNames.map((n) => n.trim());
    if (trimmed.some((n) => !n)) {
      toast({ title: "Validation error", description: "Container names must not be empty.", variant: "destructive" });
      return;
    }
    const uniq = new Set(trimmed);
    if (uniq.size !== trimmed.length) {
      toast({ title: "Validation error", description: "Container names must be unique.", variant: "destructive" });
      return;
    }
    addContainersMut.mutate({ proformaId: addCtDialog.proformaId, names: trimmed });
  }

  /* ── Close-Proforma dialog state ─────────────────────────────────────────── */
  const [closeDialog, setCloseDialog] = useState<{
    proformaId: number;
    proformaName: string;
  } | null>(null);

  const closeProformaMut = useMutation({
    mutationFn: (proformaId: number) => apiRequest("PATCH", `/api/factory/v5/proforma/${proformaId}/close`, {}),
    onSuccess: () => {
      toast({ title: "Proforma closed." });
      setCloseDialog(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error closing proforma", description: err.message ?? "Unknown error", variant: "destructive" });
    },
  });

  /* ── Edit-Draft-Quantities dialog state ─────────────────────────────────── */
  interface EditDraftArticle {
    articleCode: string;
    productName: string;
    currentExpectedQty: number;
    eligibleCount: number; // DRAFT containers with 0 loadedQty for this article
  }
  const [editDraftDialog, setEditDraftDialog] = useState<{
    proformaId: number;
    proformaName: string;
    articles: EditDraftArticle[];
  } | null>(null);
  const [editDraftQtys, setEditDraftQtys] = useState<Record<string, number>>({});

  function openEditDraft(proformaId: number, proformaName: string, currentRows: V5Row[]) {
    const articles: EditDraftArticle[] = [];
    for (const row of currentRows) {
      const pd = row.proformaDetails.find((p) => p.proformaId === proformaId);
      if (!pd) continue;
      const eligible = pd.containers.filter((c) => c.status === "DRAFT" && c.loadedQty === 0);
      if (eligible.length === 0) continue;
      articles.push({
        articleCode: row.articleCode,
        productName: row.productName,
        currentExpectedQty: eligible[0].expectedQty,
        eligibleCount: eligible.length,
      });
    }
    setEditDraftDialog({ proformaId, proformaName, articles });
    const initQtys: Record<string, number> = {};
    articles.forEach((a) => {
      initQtys[a.articleCode] = a.currentExpectedQty;
    });
    setEditDraftQtys(initQtys);
  }

  const editDraftMut = useMutation({
    mutationFn: async ({
      proformaId,
      updates,
    }: {
      proformaId: number;
      updates: { articleCode: string; expectedQty: number }[];
    }) => {
      const res = await apiRequest("PATCH", `/api/factory/v5/proforma/${proformaId}/draft-expected-lines`, { updates });
      return (await res.json()) as { updated?: number };
    },
    onSuccess: (data: { updated?: number }) => {
      toast({ title: `Draft quantities updated (${data?.updated ?? 0} lines changed).` });
      setEditDraftDialog(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({
        title: "Error updating quantities",
        description: err.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  function submitEditDraft() {
    if (!editDraftDialog) return;
    const updates = editDraftDialog.articles.map((a) => ({
      articleCode: a.articleCode,
      expectedQty: editDraftQtys[a.articleCode] ?? a.currentExpectedQty,
    }));
    const invalid = updates.find((u) => !Number.isInteger(u.expectedQty) || u.expectedQty < 0);
    if (invalid) {
      toast({
        title: "Validation error",
        description: "Quantities must be non-negative integers.",
        variant: "destructive",
      });
      return;
    }
    editDraftMut.mutate({ proformaId: editDraftDialog.proformaId, updates });
  }

  /* ── Link-Existing-Container dialog state ───────────────────────────────── */
  interface UnlinkedOrder {
    id: number;
    containerNumber: string;
    status: string;
    customerId: number | null;
    customerName: string;
    createdAt: string;
    loadedBaleCount: number;
  }
  const [linkDialog, setLinkDialog] = useState<{
    proformaId: number;
    proformaName: string;
    proformaCustomerId: number | null;
  } | null>(null);
  const [linkSelected, setLinkSelected] = useState<Set<number>>(new Set());

  const unlinkedQuery = useQuery<{ orders: UnlinkedOrder[] }>({
    queryKey: ["/api/factory/v5/unlinked-loading-orders"],
    queryFn: async () => {
      const res = await fetch("/api/factory/v5/unlinked-loading-orders", { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed");
      }
      return res.json();
    },
    enabled: !!linkDialog,
    staleTime: 15000,
  });

  const linkMut = useMutation({
    mutationFn: async ({ proformaId, orderIds }: { proformaId: number; orderIds: number[] }) => {
      const results = [];
      for (const orderId of orderIds) {
        const r = await apiRequest("PATCH", `/api/factory/customer-orders/${orderId}/link-proforma`, { proformaId });
        results.push(r);
      }
      return results;
    },
    onSuccess: (_data, { orderIds }) => {
      toast({ title: `Linked ${orderIds.length} container${orderIds.length !== 1 ? "s" : ""} to proforma.` });
      setLinkDialog(null);
      setLinkSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Linking failed", description: err.message ?? "Unknown error", variant: "destructive" });
    },
  });

  /* ── Restore-Cancelled-Container dialog state ────────────────────────────── */
  interface CancelledContainerRow {
    id: number;
    containerNumber: string;
    customerName: string;
    cancelledAt: string;
    wasLoading: boolean;
    proformaId: number | null;
    proformaName: string | null;
  }
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);

  const cancelledContainersQuery = useQuery<{ orders: CancelledContainerRow[] }>({
    queryKey: ["/api/factory/v5/recently-cancelled-containers"],
    queryFn: async () => {
      const res = await fetch("/api/factory/v5/recently-cancelled-containers", { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed");
      }
      return res.json();
    },
    enabled: restoreDialogOpen,
    staleTime: 15000,
  });

  const restoreContainerMut = useMutation({
    mutationFn: async (orderId: number) => {
      const res = await apiRequest("POST", `/api/factory/v5/containers/${orderId}/restore`, {});
      return (await res.json()) as { restoredTo?: string };
    },
    onSuccess: (data: { restoredTo?: string }) => {
      toast({ title: `Container restored to ${data?.restoredTo === "LOADING" ? "Loading" : "Draft"}.` });
      cancelledContainersQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Restore failed", description: err.message ?? "Unknown error", variant: "destructive" });
    },
  });

  /* ── Cancel-Container dialog state ──────────────────────────────────────── */
  const [cancelDialog, setCancelDialog] = useState<{
    orderId: number;
    containerName: string;
    status: "DRAFT" | "LOADING";
  } | null>(null);
  const [_cancelSuperUser, setCancelSuperUser] = useState("");
  const [_cancelSuperPass, setCancelSuperPass] = useState("");

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
      toast({ title: "Container cancelled." });
      setCancelDialog(null);
      setCancelSuperUser("");
      setCancelSuperPass("");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/stock-allocation"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Cancel failed", description: err.message ?? "Unknown error", variant: "destructive" });
    },
  });

  /* ── Query ──────────────────────────────────────────────────────────────── */
  const query = useQuery<V5Data>({
    queryKey: ["/api/factory/v5/stock-allocation", hideZero, debouncedSearch || undefined],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (hideZero) params.set("hideZero", "true");
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
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

  function isGarbageOrWipers(row: V5Row) {
    if (row.isGarbageOrWipers) return true;
    const n = row.productName.toLowerCase();
    return n.includes("wiper") || n.includes("garbage");
  }

  const allRows = (query.data?.rows ?? []).slice().sort((a, b) => a.productName.localeCompare(b.productName));
  const garbageWipersCount = allRows.filter(isGarbageOrWipers).length;
  const filteredRows = showGarbageWipers ? allRows : allRows.filter((r) => !isGarbageOrWipers(r));
  const negativeFilteredRows = showNegativeOnly ? filteredRows.filter((r) => r.freeToPromise < 0) : filteredRows;
  const categoryFilteredRows =
    categoryFilter.length > 0
      ? negativeFilteredRows.filter((r) => categoryFilter.includes(r.categoryName ?? ""))
      : negativeFilteredRows;
  const rows = searchQuery.trim()
    ? categoryFilteredRows.filter((r) => {
        const q = searchQuery.toLowerCase();
        return r.productName.toLowerCase().includes(q) || r.articleCode.toLowerCase().includes(q);
      })
    : categoryFilteredRows;

  // Unique sorted category names from all loaded rows (unfiltered) for the dropdown
  const allCategories = useMemo(() => {
    const cats = new Set<string>();
    allRows.forEach((r) => {
      if (r.categoryName) cats.add(r.categoryName);
    });
    return Array.from(cats).sort();
  }, [allRows]);
  const totals = query.data?.totals;

  // Auto-expand rows that contain the focused proforma, then scroll to first match
  useEffect(() => {
    if (!focusProformaId || rows.length === 0) return;
    const toExpand = rows
      .filter((r) => r.proformaDetails.some((p) => p.proformaId === focusProformaId))
      .map((r) => r.articleCode);
    if (toExpand.length === 0) return;
    setExpandedRows((prev) => {
      const next = new Set(prev);
      toExpand.forEach((c) => next.add(c));
      return next;
    });
    // Scroll after a tick so the rows have rendered
    setTimeout(() => {
      firstMatchRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
  }, [focusProformaId, rows, rows.length]);

  // Auto-open edit drawer when navigated here with openEdit=true
  const editOpenedRef = useRef(false);
  useEffect(() => {
    if (!openEditOnLoad || !focusProformaId || rows.length === 0 || editOpenedRef.current) return;
    editOpenedRef.current = true;
    setEditDrawerProformaId(focusProformaId);
  }, [openEditOnLoad, focusProformaId, rows.length]);

  const handleRefresh = useCallback(() => {
    query.refetch().then(() => {
      setRefreshFlash(true);
      setTimeout(() => setRefreshFlash(false), 1500);
    });
  }, [query]);

  function toggleRow(code: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  /* ── Excel export ────────────────────────────────────────────────────────── */
  async function handleExportExcel() {
    const XLSX = (await import("xlsx-js-style")).default;

    const filtered = rows.filter((r) => {
      if (r.freeToPromise > 0) return exportIncludePositive;
      if (r.freeToPromise < 0) return exportIncludeNegative;
      return exportIncludeZero;
    });

    // ── colour helpers ──────────────────────────────────────────────────────
    const headerFill = { patternType: "solid", fgColor: { rgb: "1E293B" } };
    const headerFont = { bold: true, color: { rgb: "F8FAFC" }, sz: 10 };
    const positiveFill = { patternType: "solid", fgColor: { rgb: "DCFCE7" } };
    const negativeFill = { patternType: "solid", fgColor: { rgb: "FEE2E2" } };
    const neutralFill = { patternType: "solid", fgColor: { rgb: "F1F5F9" } };
    const monoFont = { name: "Courier New", sz: 10 };
    const border = {
      top: { style: "thin", color: { rgb: "CBD5E1" } },
      bottom: { style: "thin", color: { rgb: "CBD5E1" } },
      left: { style: "thin", color: { rgb: "CBD5E1" } },
      right: { style: "thin", color: { rgb: "CBD5E1" } },
    };

    function hCell(v: string) {
      return {
        v,
        t: "s",
        s: { fill: headerFill, font: headerFont, alignment: { horizontal: "center", vertical: "center" }, border },
      };
    }
    function numCell(v: number, fill?: object, color?: string) {
      return {
        v,
        t: "n",
        s: {
          font: { ...monoFont, ...(color ? { color: { rgb: color } } : {}) },
          fill: fill ?? { patternType: "solid", fgColor: { rgb: "FFFFFF" } },
          alignment: { horizontal: "right" },
          border,
        },
      };
    }
    function txtCell(v: string, bold = false) {
      return { v, t: "s", s: { font: { sz: 10, bold }, alignment: { horizontal: "left", wrapText: true }, border } };
    }

    const headerRow = [
      hCell("Article Code"),
      hCell("Product Name"),
      hCell("Stock Available"),
      hCell("Expected to Load"),
      hCell("Total Loaded"),
      hCell("Available Balance"),
    ];

    const dataRows = filtered.map((r) => {
      const bal = r.freeToPromise;
      const balFill = bal > 0 ? positiveFill : bal < 0 ? negativeFill : neutralFill;
      const balColor = bal > 0 ? "15803D" : bal < 0 ? "DC2626" : "64748B";
      return [
        txtCell(r.articleCode, true),
        txtCell(r.productName),
        numCell(r.stockAvailable, { patternType: "solid", fgColor: { rgb: "FFFFFF" } }, "15803D"),
        numCell(r.expectedToLoad, { patternType: "solid", fgColor: { rgb: "FFFFFF" } }, "D97706"),
        numCell(r.totalLoaded, { patternType: "solid", fgColor: { rgb: "FFFFFF" } }, "2563EB"),
        numCell(bal, balFill, balColor),
      ];
    });

    // Totals row
    const totalsBal = filtered.reduce((s, r) => s + r.freeToPromise, 0);
    const totalsRow = [
      {
        v: "TOTALS",
        t: "s",
        s: {
          font: { bold: true, sz: 10 },
          fill: { patternType: "solid", fgColor: { rgb: "E2E8F0" } },
          alignment: { horizontal: "left" },
          border,
        },
      },
      {
        v: `${filtered.length} products`,
        t: "s",
        s: {
          font: { sz: 10, color: { rgb: "64748B" } },
          fill: { patternType: "solid", fgColor: { rgb: "E2E8F0" } },
          alignment: { horizontal: "left" },
          border,
        },
      },
      numCell(
        filtered.reduce((s, r) => s + r.stockAvailable, 0),
        { patternType: "solid", fgColor: { rgb: "E2E8F0" } },
        "15803D"
      ),
      numCell(
        filtered.reduce((s, r) => s + r.expectedToLoad, 0),
        { patternType: "solid", fgColor: { rgb: "E2E8F0" } },
        "D97706"
      ),
      numCell(
        filtered.reduce((s, r) => s + r.totalLoaded, 0),
        { patternType: "solid", fgColor: { rgb: "E2E8F0" } },
        "2563EB"
      ),
      numCell(
        totalsBal,
        { patternType: "solid", fgColor: { rgb: "E2E8F0" } },
        totalsBal < 0 ? "DC2626" : totalsBal > 0 ? "15803D" : "64748B"
      ),
    ];

    const wsData = [headerRow, ...dataRows, totalsRow];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    ws["!cols"] = [
      { wch: 16 }, // Article Code
      { wch: 36 }, // Product Name
      { wch: 16 }, // Stock Available
      { wch: 18 }, // Expected to Load
      { wch: 14 }, // Total Loaded
      { wch: 18 }, // Available Balance
    ];
    ws["!rows"] = [{ hpt: 22 }, ...dataRows.map(() => ({ hpt: 18 })), { hpt: 22 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Stock Allocation");

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    XLSX.writeFile(wb, `stock_allocation_${stamp}.xlsx`);
    setExportDialogOpen(false);
  }

  /* ── Article rows for the drawer ──────────────────────────────────────── */
  const drawerRows = useMemo(
    () =>
      allRows.map((r) => ({
        articleCode: r.articleCode,
        productName: r.productName,
        stockAvailable: r.stockAvailable,
        totalLoaded: r.totalLoaded,
        expectedToLoad: r.expectedToLoad,
        freeToPromise: r.freeToPromise,
      })),
    [allRows]
  );

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
    setCategoryFilter((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  }
  const catLabel =
    categoryFilter.length === 0
      ? "All Categories"
      : categoryFilter.length === 1
        ? categoryFilter[0]
        : `${categoryFilter.length} categories`;

  return {
    focusProformaId,
    firstMatchRef,
    createDrawerOpen,
    setCreateDrawerOpen,
    editDrawerProformaId,
    setEditDrawerProformaId,
    expandedRows,
    hideZero,
    setHideZero,
    showNegativeOnly,
    setShowNegativeOnly,
    showGarbageWipers,
    setShowGarbageWipers,
    refreshFlash,
    searchQuery,
    setSearchQuery,
    categoryFilter,
    setCategoryFilter,
    exportDialogOpen,
    setExportDialogOpen,
    exportIncludePositive,
    setExportIncludePositive,
    exportIncludeNegative,
    setExportIncludeNegative,
    exportIncludeZero,
    setExportIncludeZero,
    addCtDialog,
    setAddCtDialog,
    ctCount,
    ctNames,
    openAddContainers,
    handleCtCountChange,
    handleCtNameChange,
    addContainersMut,
    submitAddContainers,
    closeDialog,
    setCloseDialog,
    closeProformaMut,
    editDraftDialog,
    setEditDraftDialog,
    editDraftQtys,
    setEditDraftQtys,
    openEditDraft,
    editDraftMut,
    submitEditDraft,
    linkDialog,
    setLinkDialog,
    linkSelected,
    setLinkSelected,
    unlinkedQuery,
    linkMut,
    restoreDialogOpen,
    setRestoreDialogOpen,
    cancelledContainersQuery,
    restoreContainerMut,
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
    drawerRows,
    catDropOpen,
    setCatDropOpen,
    catDropRef,
    toggleCategory,
    catLabel,
  } as const;
}
