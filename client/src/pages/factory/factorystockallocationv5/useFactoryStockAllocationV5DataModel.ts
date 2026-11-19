// Extracted from ./useFactoryStockAllocationV5Model.tsx: state, queries and mutations for useFactoryStockAllocationV5Model.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { fetchAllV5AllocationData } from "@/lib/v5AllocationPaginationClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useCompany } from "@/contexts/CompanyContext";
import { useDebounce } from "@/hooks/use-debounce";
import type { V5Row } from "./types";

export function useFactoryStockAllocationV5DataModel() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const searchString = useSearch();
  const focusProformaId = useMemo(() => {
    const p = new URLSearchParams(searchString).get("proformaId");
    return p ? parseInt(p) : null;
  }, [searchString]);

  const openEditOnLoad = useMemo(() => {
    return new URLSearchParams(searchString).get("openEdit") === "true";
  }, [searchString]);

  const firstMatchRef = useRef<HTMLTableRowElement | null>(null);
  // Track the focused proforma we already auto-scrolled to. The focus query
  // parameter can stay in the URL while the user is working on this page, so
  // re-renders must not keep pulling the scroll position back to that row.
  const autoScrolledProformaIdRef = useRef<number | null>(null);

  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [hideZero, setHideZero] = useState(false);
  const [showNegativeOnly, setShowNegativeOnly] = useState(false);
  const [showGarbageWipers, setShowGarbageWipers] = useState(false);
  const [refreshFlash, setRefreshFlash] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  // Debounced value sent to the server — prevents one request per keystroke.
  const debouncedSearch = useDebounce(searchQuery, 300);

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

  async function openEditDraft(proformaId: number, proformaName: string, _currentRows: V5Row[]) {
    // Always load the complete catalog, not only the stock-allocation rows
    // currently displayed by progressive pagination.
    let currentRows: V5Row[];
    try {
      const complete = await fetchAllV5AllocationData(new URLSearchParams());
      currentRows = complete.rows as V5Row[];
    } catch (error) {
      toast({
        title: "Unable to load draft products",
        description: error instanceof Error ? error.message : "The complete stock allocation list could not be loaded.",
        variant: "destructive",
      });
      return;
    }
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
    queryKey: companyQueryKey("/api/factory/v5/unlinked-loading-orders", selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/v5/unlinked-loading-orders", { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed");
      }
      return res.json();
    },
    enabled: !!linkDialog && Boolean(selectedCompany?.id),
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
    queryKey: companyQueryKey("/api/factory/v5/recently-cancelled-containers", selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch("/api/factory/v5/recently-cancelled-containers", { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed");
      }
      return res.json();
    },
    enabled: restoreDialogOpen && Boolean(selectedCompany?.id),
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

  return {
    toast,
    selectedCompany,
    navigate,
    focusProformaId,
    openEditOnLoad,
    firstMatchRef,
    autoScrolledProformaIdRef,
    createDrawerOpen,
    setCreateDrawerOpen,
    expandedRows,
    setExpandedRows,
    hideZero,
    setHideZero,
    showNegativeOnly,
    setShowNegativeOnly,
    showGarbageWipers,
    setShowGarbageWipers,
    refreshFlash,
    setRefreshFlash,
    searchQuery,
    setSearchQuery,
    categoryFilter,
    setCategoryFilter,
    debouncedSearch,
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
  };
}
