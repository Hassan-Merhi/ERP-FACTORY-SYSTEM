// Extracted from ./FactoryShippingContainers.tsx: state, queries and handlers for FactoryShippingContainers.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import type { DisplayRow, ShippingRow, TrackingRow } from "./factoryshippingcontainers/types";
import { LIST_KEY, STATUS_ORDER, localIsoDate } from "./factoryshippingcontainers/utils";
import { useShippingColumnVisibility } from "./factoryshippingcontainers/hooks/useShippingColumnVisibility";
import { type DocsFilter } from "./factoryshippingcontainers/components/FilterPanel";
import { isShippingEtaOverdue } from "./factoryshippingcontainers/components/ShippingDashboardOverview";
import {
  type ShippingQuickMode,
  type ShippingQuickSelection,
} from "./factoryshippingcontainers/components/ShippingStatusChips";

export function useFactoryShippingContainersModel() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [filterDocs, setFilterDocs] = useState<DocsFilter>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [destinationFilter, setDestinationFilter] = useState("all");
  const [shippingCompanyFilter, setShippingCompanyFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [quickMode, setQuickMode] = useState<ShippingQuickMode>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [showFilters, setShowFilters] = useState(false);
  const [docsRowId, setDocsRowId] = useState<number | null>(null);
  const [waRowId, setWaRowId] = useState<number | null>(null);
  const shippingInvoiceInputRef = useRef<HTMLInputElement>(null);
  const [shippingInvoiceUploadingId, setShippingInvoiceUploadingId] = useState<number | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [donePage, setDonePage] = useState(1);
  const [pendingDoneId, setPendingDoneId] = useState<number | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  interface AuthMe {
    id: number;
    role?: string;
    currentCompanyId?: number | null;
    companyId?: number | null;
  }
  const { data: me } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const { colVis, toggleCol, showAllCols, hiddenCount } = useShippingColumnVisibility(me?.id);
  const clientLeft: 130 | 0 = colVis.invoiceNumber ? 130 : 0;
  const containerLeft = clientLeft + (colVis.clientName ? 144 : 0);

  // ── Data ──────────────────────────────────────────────────────────────────────
  const { data: activeRows = [], isLoading } = useQuery<ShippingRow[]>({
    queryKey: [LIST_KEY, "active"],
    queryFn: async () => {
      const response = await fetch(`${LIST_KEY}?isDone=false&pageSize=500`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load active shipping containers");
      return response.json();
    },
  });

  const { data: donePageData } = useQuery<{
    rows: ShippingRow[];
    total: number;
    totalPages: number;
  }>({
    queryKey: [LIST_KEY, "done", donePage],
    queryFn: async () => {
      const response = await fetch(`${LIST_KEY}?isDone=true&page=${donePage}&pageSize=100`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to load completed shipping containers");
      const rows = await response.json();
      const total = Number(response.headers.get("X-Total-Count")) || rows.length;
      const totalPages = Number(response.headers.get("X-Total-Pages")) || (total > 0 ? 1 : 0);
      return { rows, total, totalPages };
    },
    enabled: doneExpanded,
    placeholderData: (previous) => previous,
  });
  const done = useMemo(() => donePageData?.rows ?? [], [donePageData?.rows]);
  const doneTotal = donePageData?.total ?? 0;
  const doneTotalPages = donePageData?.totalPages ?? 0;

  const { data: trackingData = [] } = useQuery<TrackingRow[]>({
    queryKey: ["/api/factory/invoice-container-tracking"],
  });

  // Auto-create backing rows for all active orders on mount
  const syncMutation = useMutation({
    mutationFn: () => apiRequest("POST", `${LIST_KEY}/sync`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [LIST_KEY] }),
  });
  const syncShippingContainers = syncMutation.mutate;
  useEffect(() => {
    if (!me?.id) return;
    const companyScope = me.currentCompanyId ?? me.companyId ?? "current";
    const storageKey = `factory-shipping-containers:last-sync:${companyScope}`;
    const now = Date.now();
    try {
      const lastSync = Number(localStorage.getItem(storageKey) || 0);
      if (now - lastSync < 5 * 60_000) return;
      localStorage.setItem(storageKey, String(now));
    } catch {
      // Storage can be unavailable in privacy mode; a single page-mount sync is still safe.
    }
    syncShippingContainers();
  }, [me?.id, me?.currentCompanyId, me?.companyId, syncShippingContainers]);

  const rows = useMemo(() => [...activeRows, ...done], [activeRows, done]);

  // Current row for docs modal (search real rows only)
  const docsRow = docsRowId ? rows.find((r) => r.id === docsRowId) : null;

  // ── Mutations ─────────────────────────────────────────────────────────────────

  const patchRowMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: object }) => apiRequest("PATCH", `${LIST_KEY}/${id}`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [LIST_KEY] }),
    onError: (e: ClientErrorLike) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const syncOrderMutation = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: object }) =>
      apiRequest("PATCH", `${LIST_KEY}/${id}/sync-order`, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [LIST_KEY] }),
    onError: (e: ClientErrorLike) => toast({ title: "Update failed", description: e.message, variant: "destructive" }),
  });

  const doneMutation = useMutation({
    mutationFn: ({ id, markWaSent }: { id: number; markWaSent?: boolean }) =>
      apiRequest("POST", `${LIST_KEY}/${id}/done`, { markWhatsappSent: markWaSent }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [LIST_KEY] });
      toast({ title: "Marked as done" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `${LIST_KEY}/${id}/restore`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [LIST_KEY] });
      toast({ title: "Restored to active" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const deleteRowMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${LIST_KEY}/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [LIST_KEY] });
      toast({ title: "Container record deleted" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  const uploadShippingInvoiceMutation = useMutation({
    mutationFn: async ({ id, file }: { id: number; file: File }) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${LIST_KEY}/${id}/shipping-invoice`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Upload failed" }));
        throw new Error(err.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [LIST_KEY] });
      toast({ title: "Shipping invoice uploaded" });
      setShippingInvoiceUploadingId(null);
    },
    onError: (e: ClientErrorLike) => {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
      setShippingInvoiceUploadingId(null);
    },
  });

  function handleShippingInvoiceFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || shippingInvoiceUploadingId === null) return;
    uploadShippingInvoiceMutation.mutate({ id: shippingInvoiceUploadingId, file });
    e.target.value = "";
  }

  // ── Tracking map: containerNumber → {eta, grandTotal} ────────────────────────
  const trackingMap = useMemo(() => {
    const m = new Map<string, TrackingRow>();
    for (const t of trackingData) {
      if (t.containerNumber) m.set(t.containerNumber.trim().toUpperCase(), t);
    }
    return m;
  }, [trackingData]);

  // ── All display rows sorted by status ────────────────────────────────────────
  const allDisplayRows = useMemo((): DisplayRow[] => {
    const display: DisplayRow[] = activeRows.map((r) => {
      const ckey = (r.containerNumber || "").trim().toUpperCase();
      const tracked = ckey ? trackingMap.get(ckey) : undefined;
      return { ...r, _isGhost: false, _trackedEta: tracked?.eta ?? null };
    });
    display.sort((a, b) => {
      const sa = STATUS_ORDER[a.status] ?? 9;
      const sb = STATUS_ORDER[b.status] ?? 9;
      if (sa !== sb) return sa - sb;
      return (b.orderDate || "").localeCompare(a.orderDate || "");
    });
    return display;
  }, [activeRows, trackingMap]);

  // ── Shipping filters and local pagination (backing rows are unchanged). ──
  const today = localIsoDate();

  const destinations = useMemo(
    () => [...new Set(allDisplayRows.map((r) => r.destination?.trim()).filter((v): v is string => Boolean(v)))].sort(),
    [allDisplayRows]
  );
  const shippingCompanies = useMemo(
    () =>
      [...new Set(allDisplayRows.map((r) => r.shippingCompany?.trim()).filter((v): v is string => Boolean(v)))].sort(),
    [allDisplayRows]
  );

  // Date controls compare ISO calendar dates rather than timestamps. Blank = no restriction.
  const scopedRows = useMemo(
    () =>
      allDisplayRows.filter((r) => {
        const q = search.toLowerCase().trim();
        if (
          q &&
          ![r.invoiceNumber, r.clientName, r.containerNumber, r.destination, r.shippingCompany, r.anything].some(
            (value) => (value || "").toLowerCase().includes(q)
          )
        )
          return false;
        if (destinationFilter !== "all" && r.destination?.trim() !== destinationFilter) return false;
        if (shippingCompanyFilter !== "all" && r.shippingCompany?.trim() !== shippingCompanyFilter) return false;
        const orderDay = (r.orderDate || "").slice(0, 10);
        if (dateFrom && (!orderDay || orderDay < dateFrom)) return false;
        if (dateTo && (!orderDay || orderDay > dateTo)) return false;
        return true;
      }),
    [allDisplayRows, search, destinationFilter, shippingCompanyFilter, dateFrom, dateTo]
  );

  const filtered = useMemo(
    () =>
      scopedRows.filter((r) => {
        if (filterDocs === "has" && r.documentCount === 0) return false;
        if (filterDocs === "missing" && r.documentCount > 0) return false;
        if (filterStatus !== "all") {
          const effective = r.status === "PENDING_VERIFICATION" ? "VERIFIED" : r.status;
          if (effective !== filterStatus) return false;
        }
        if (quickMode === "overdue" && !isShippingEtaOverdue(r, today)) return false;
        if (quickMode === "arrived" && !r.containerArrivedDate) return false;
        return true;
      }),
    [scopedRows, filterDocs, filterStatus, quickMode, today]
  );

  // Reset the paginator when the selected record set changes.
  useEffect(
    () => setPage(1),
    [search, destinationFilter, shippingCompanyFilter, dateFrom, dateTo, filterStatus, filterDocs, quickMode, pageSize]
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const hasActiveFilters = filterDocs !== "all" || filterStatus !== "all" || quickMode !== "all";

  function applyQuickSelection(value: ShippingQuickSelection) {
    if (value === "all") {
      setFilterStatus("all");
      setFilterDocs("all");
      setQuickMode("all");
    } else if (value === "LOADING" || value === "VERIFIED" || value === "FINALIZED") {
      setFilterStatus(value);
      setFilterDocs("all");
      setQuickMode("all");
    } else if (value === "missing" || value === "has") {
      setFilterStatus("all");
      setFilterDocs(value);
      setQuickMode("all");
    } else {
      setFilterStatus("all");
      setFilterDocs("all");
      setQuickMode(value);
    }
  }

  return {
    navigate,
    search,
    setSearch,
    filterDocs,
    setFilterDocs,
    filterStatus,
    setFilterStatus,
    destinationFilter,
    setDestinationFilter,
    shippingCompanyFilter,
    setShippingCompanyFilter,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    quickMode,
    setQuickMode,
    setPage,
    pageSize,
    setPageSize,
    showFilters,
    setShowFilters,
    docsRowId,
    setDocsRowId,
    waRowId,
    setWaRowId,
    shippingInvoiceInputRef,
    doneExpanded,
    setDoneExpanded,
    donePage,
    setDonePage,
    pendingDoneId,
    setPendingDoneId,
    pendingDeleteId,
    setPendingDeleteId,
    me,
    colVis,
    toggleCol,
    showAllCols,
    hiddenCount,
    clientLeft,
    containerLeft,
    isLoading,
    done,
    doneTotal,
    doneTotalPages,
    docsRow,
    patchRowMutation,
    syncOrderMutation,
    doneMutation,
    restoreMutation,
    deleteRowMutation,
    handleShippingInvoiceFileChange,
    allDisplayRows,
    today,
    destinations,
    shippingCompanies,
    scopedRows,
    filtered,
    pageCount,
    currentPage,
    visibleRows,
    hasActiveFilters,
    applyQuickSelection,
  };
}

export type FactoryShippingContainersModel = ReturnType<typeof useFactoryShippingContainersModel>;
