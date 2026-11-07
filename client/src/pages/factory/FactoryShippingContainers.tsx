import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MessageCircle, Trash2, Check, CheckCircle2, Loader2, ArrowLeft, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";

import type { DisplayRow, ShippingRow, TrackingRow } from "./factoryshippingcontainers/types";
import {
  INV_LEFT,
  LIST_KEY,
  STATUS_ORDER,
  fmtDate,
  statusColor,
  statusLabel,
  stickyCellBase,
  stickyHeadBase,
} from "./factoryshippingcontainers/utils";
import { DocIndicator } from "./factoryshippingcontainers/components/DocIndicator";
import { EditableCellInput } from "./factoryshippingcontainers/components/EditableCellInput";
import { DateCellInput } from "./factoryshippingcontainers/components/DateCellInput";
import { DocumentsModal } from "./factoryshippingcontainers/components/DocumentsModal";
import { WhatsAppModal } from "./factoryshippingcontainers/components/WhatsAppModal";
import { ShippingAvailabilityTable } from "./factoryshippingcontainers/components/ShippingAvailabilityTable";
import { ScheduledContainersTable } from "./factoryshippingcontainers/components/ScheduledContainersTable";
import { useShippingColumnVisibility } from "./factoryshippingcontainers/hooks/useShippingColumnVisibility";
import { FilterPanel, type DocsFilter } from "./factoryshippingcontainers/components/FilterPanel";
import { ShippingToolbar } from "./factoryshippingcontainers/components/ShippingToolbar";
import { DoneContainersSection } from "./factoryshippingcontainers/components/DoneContainersSection";
import { ShippingConfirmDialogs } from "./factoryshippingcontainers/components/ShippingConfirmDialogs";
import {
  ShippingDashboardOverview,
  isShippingEtaOverdue,
} from "./factoryshippingcontainers/components/ShippingDashboardOverview";
import {
  ShippingStatusChips,
  type ShippingQuickMode,
  type ShippingQuickSelection,
} from "./factoryshippingcontainers/components/ShippingStatusChips";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export default function FactoryShippingContainers() {
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
  const clientLeft = colVis.invoiceNumber ? 130 : 0;
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
  const today = (() => {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  })();

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

  return (
    <>
      <div className="space-y-3" data-testid="shipping-compact-dashboard">
        <ShippingDashboardOverview
          rows={scopedRows}
          today={today}
          dateFrom={dateFrom}
          dateTo={dateTo}
          onDateFrom={setDateFrom}
          onDateTo={setDateTo}
          onOpenInvoicing={() => navigate("/factory/sales/new")}
          allowNewOrder={Boolean(me?.role && !isExistingRecordReadOnlyRole(me.role))}
          showOrderValue={colVis.containerCost}
        />
        {/* ── Compact search + controls ── */}
        <ShippingToolbar
          search={search}
          onSearch={setSearch}
          filterStatus={filterStatus}
          onFilterStatus={(value) => {
            setFilterStatus(value);
            setQuickMode("all");
          }}
          destinationFilter={destinationFilter}
          onDestinationFilter={setDestinationFilter}
          destinations={destinations}
          shippingCompanyFilter={shippingCompanyFilter}
          onShippingCompanyFilter={setShippingCompanyFilter}
          shippingCompanies={shippingCompanies}
          showFilters={showFilters}
          onToggleFilters={() => setShowFilters((v) => !v)}
          hasActiveFilters={hasActiveFilters}
          colVis={colVis}
          toggleCol={toggleCol}
          showAllCols={showAllCols}
          hiddenCount={hiddenCount}
        />

        {/* ── Filter Panel ── */}
        {showFilters && (
          <FilterPanel
            filterDocs={filterDocs}
            setFilterDocs={(value) => {
              setFilterDocs(value);
              setQuickMode("all");
            }}
            filterStatus={filterStatus}
            setFilterStatus={(value) => {
              setFilterStatus(value);
              setQuickMode("all");
            }}
          />
        )}

        <ShippingStatusChips
          rows={scopedRows}
          today={today}
          filterStatus={filterStatus}
          filterDocs={filterDocs}
          quickMode={quickMode}
          onSelect={applyQuickSelection}
        />
        <p className="px-1 text-[11px] text-muted-foreground">
          Select Container #, Destination, ETA, Shipping Co., Note, Anything or Arrived to edit inline.
        </p>

        {/* ── Main Table ── */}
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm dark:bg-[#0e1b2e]">
          <Table
            mobileLayout="cards"
            className="text-xs [&_td]:px-2.5 [&_td]:py-1.5 [&_th]:h-9 [&_th]:px-2.5 [&_th]:py-1.5"
            wrapperClassName="overflow-x-auto"
            style={{ minWidth: "1100px" }}
          >
            <TableHeader className="sticky top-0 z-20">
              <TableRow className="bg-slate-100/90 hover:bg-slate-100/90 dark:bg-[#182a43] dark:hover:bg-[#182a43]">
                {colVis.orderDate && <TableHead className="text-xs w-20 min-w-[80px]">Order Date</TableHead>}
                {colVis.invoiceNumber && (
                  <TableHead
                    className={cn(stickyHeadBase, "shipping-sticky")}
                    style={{ left: INV_LEFT, minWidth: "130px", width: "130px" }}
                  >
                    Invoice #
                  </TableHead>
                )}
                {colVis.clientName && (
                  <TableHead
                    className={cn(stickyHeadBase, "shipping-sticky")}
                    style={{ left: clientLeft, minWidth: "144px", width: "144px" }}
                  >
                    Client
                  </TableHead>
                )}
                {colVis.status && <TableHead className="text-xs w-24 min-w-[96px]">Status</TableHead>}
                {colVis.containerNumber && (
                  <TableHead
                    className={cn(stickyHeadBase, "shipping-sticky")}
                    style={{ left: containerLeft, minWidth: "120px", width: "120px" }}
                  >
                    Container #
                  </TableHead>
                )}
                {colVis.destination && <TableHead className="text-xs min-w-[120px]">Destination</TableHead>}
                {colVis.eta && <TableHead className="text-xs min-w-[100px]">ETA</TableHead>}
                {colVis.arrived && <TableHead className="text-xs min-w-[90px]">Arrived</TableHead>}
                {colVis.finalized && <TableHead className="text-xs min-w-[90px]">Finalized</TableHead>}
                {colVis.shippingCo && <TableHead className="text-xs min-w-[110px]">Shipping Co.</TableHead>}
                {colVis.documents && <TableHead className="text-xs min-w-[90px]">Documents</TableHead>}
                {colVis.containerCost && <TableHead className="text-xs min-w-[100px]">Container Cost</TableHead>}
                {colVis.ciNumber && <TableHead className="text-xs min-w-[100px]">CI No.</TableHead>}
                {colVis.note && <TableHead className="text-xs min-w-[110px]">Note</TableHead>}
                {colVis.anything && <TableHead className="text-xs min-w-[150px]">Anything</TableHead>}
                {colVis.whatsapp && <TableHead className="text-xs min-w-[90px]">WhatsApp</TableHead>}
                {colVis.done && <TableHead className="text-xs min-w-[80px]">Done</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={18} className="text-center py-10 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={18} className="text-center py-10 text-muted-foreground">
                    {allDisplayRows.length === 0 ? "No active records." : "No records match the current filters."}
                  </TableCell>
                </TableRow>
              ) : (
                visibleRows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="border-border/40 hover:bg-blue-500/[0.035] dark:hover:bg-blue-400/[0.055]"
                    data-testid={`row-record-${r.id}`}
                  >
                    {colVis.orderDate && (
                      <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.orderDate)}</TableCell>
                    )}

                    {/* Sticky: Invoice # */}
                    {colVis.invoiceNumber && (
                      <TableCell className={cn(stickyCellBase, "shipping-sticky")} style={{ left: INV_LEFT }}>
                        <span className="font-mono font-medium text-xs whitespace-nowrap">{r.invoiceNumber}</span>
                      </TableCell>
                    )}

                    {/* Sticky: Client */}
                    {colVis.clientName && (
                      <TableCell
                        className={cn(stickyCellBase, "shipping-sticky font-medium text-xs max-w-[144px] truncate")}
                        style={{ left: clientLeft }}
                        title={r.clientName || ""}
                      >
                        {r.clientName || "—"}
                      </TableCell>
                    )}

                    {colVis.status && (
                      <TableCell>
                        <button
                          className="focus:outline-hidden"
                          title="Open order"
                          onClick={() => {
                            if (!r.customerOrderId) return;
                            if (r.status === "FINALIZED") {
                              navigate(`/factory/sales/invoices/${r.customerOrderId}`);
                            } else {
                              navigate(`/factory/sales/pending-invoices/${r.customerOrderId}/verify`);
                            }
                          }}
                          data-testid={`button-status-${r.id}`}
                        >
                          <Badge
                            className={cn("shipping-status whitespace-nowrap cursor-pointer", statusColor(r.status))}
                          >
                            {statusLabel(r.status)}
                          </Badge>
                        </button>
                      </TableCell>
                    )}

                    {/* Sticky: Container # */}
                    {colVis.containerNumber && (
                      <TableCell className={cn(stickyCellBase, "shipping-sticky")} style={{ left: containerLeft }}>
                        <EditableCellInput
                          value={r.containerNumber || ""}
                          placeholder="Enter #"
                          onSave={(v) => syncOrderMutation.mutate({ id: r.id, patch: { containerNumber: v || null } })}
                          testId={`cell-container-${r.id}`}
                          saving={syncOrderMutation.isPending}
                        />
                      </TableCell>
                    )}

                    {colVis.destination && (
                      <TableCell>
                        <EditableCellInput
                          value={r.destination || ""}
                          placeholder="Enter destination"
                          onSave={(v) => syncOrderMutation.mutate({ id: r.id, patch: { destination: v || null } })}
                          testId={`cell-destination-${r.id}`}
                        />
                      </TableCell>
                    )}

                    {colVis.eta && (
                      <TableCell>
                        {r._trackedEta ? (
                          <span
                            className="text-xs text-blue-600 dark:text-blue-400 font-medium whitespace-nowrap"
                            title="Auto from tracking"
                          >
                            {fmtDate(r._trackedEta)}
                          </span>
                        ) : (
                          <DateCellInput
                            value={r.eta || ""}
                            placeholder="Set ETA"
                            onSave={(v) => patchRowMutation.mutate({ id: r.id, patch: { eta: v || null } })}
                            testId={`cell-eta-${r.id}`}
                          />
                        )}
                      </TableCell>
                    )}

                    {colVis.arrived && (
                      <TableCell>
                        <DateCellInput
                          value={r.containerArrivedDate || ""}
                          placeholder="Not arrived"
                          onSave={(v) =>
                            patchRowMutation.mutate({ id: r.id, patch: { containerArrivedDate: v || null } })
                          }
                          testId={`cell-arrived-${r.id}`}
                        />
                      </TableCell>
                    )}

                    {colVis.finalized && (
                      <TableCell className="whitespace-nowrap">
                        {r.finalizedDate ? (
                          <span className="shipping-date shipping-date-complete">
                            <CheckCircle2 className="mr-1 h-3 w-3" /> {fmtDate(r.finalizedDate)}
                          </span>
                        ) : (
                          <span className="shipping-date shipping-date-pending">Not finalized</span>
                        )}
                      </TableCell>
                    )}

                    {colVis.shippingCo && (
                      <TableCell>
                        <EditableCellInput
                          value={r.shippingCompany || ""}
                          placeholder="Enter company"
                          onSave={(v) => syncOrderMutation.mutate({ id: r.id, patch: { shippingCompany: v || null } })}
                          testId={`cell-shipping-${r.id}`}
                        />
                      </TableCell>
                    )}

                    {colVis.documents && (
                      <TableCell>
                        <DocIndicator count={r.documentCount} onClick={() => setDocsRowId(r.id)} />
                      </TableCell>
                    )}

                    {colVis.containerCost && (
                      <TableCell className="text-xs whitespace-nowrap font-medium">
                        {r.grandTotal ? (
                          <span className="shipping-cost">${Number(r.grandTotal).toLocaleString()}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}

                    {colVis.ciNumber && (
                      <TableCell>
                        <EditableCellInput
                          value={r.ciNumber || ""}
                          placeholder="Enter CI #"
                          onSave={(v) => patchRowMutation.mutate({ id: r.id, patch: { ciNumber: v || null } })}
                          testId={`cell-ci-${r.id}`}
                        />
                      </TableCell>
                    )}

                    {colVis.note && (
                      <TableCell>
                        <EditableCellInput
                          value={r.note || ""}
                          placeholder="Add note"
                          onSave={(v) => patchRowMutation.mutate({ id: r.id, patch: { note: v || null } })}
                          testId={`cell-note-${r.id}`}
                        />
                      </TableCell>
                    )}

                    {colVis.anything && (
                      <TableCell>
                        <EditableCellInput
                          value={r.anything || ""}
                          placeholder="Type anything"
                          onSave={(v) => patchRowMutation.mutate({ id: r.id, patch: { anything: v || null } })}
                          testId={`cell-anything-${r.id}`}
                        />
                      </TableCell>
                    )}

                    {colVis.whatsapp && (
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-green-300 text-green-700 dark:border-green-700 dark:text-green-400 whitespace-nowrap"
                          onClick={() => setWaRowId(r.id)}
                          data-testid={`button-prepare-wa-${r.id}`}
                        >
                          <MessageCircle className="h-3.5 w-3.5 mr-1" /> Prepare
                        </Button>
                      </TableCell>
                    )}

                    {colVis.done && (
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPendingDoneId(r.id)}
                            data-testid={`button-mark-done-${r.id}`}
                          >
                            <Check className="h-3.5 w-3.5 mr-1" /> Done
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setPendingDeleteId(r.id)}
                            data-testid={`button-delete-row-${r.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
            <span>
              Showing {filtered.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}–
              {Math.min(currentPage * pageSize, filtered.length)} of {filtered.length} orders
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 rounded-lg"
                disabled={currentPage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                aria-label="Previous shipping page"
                data-testid="shipping-prev-page"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </Button>
              <span className="min-w-14 text-center tabular-nums">
                {currentPage} / {pageCount}
              </span>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 rounded-lg"
                disabled={currentPage >= pageCount}
                onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                aria-label="Next shipping page"
                data-testid="shipping-next-page"
              >
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
              <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
                <SelectTrigger
                  className="h-8 w-[98px] rounded-lg text-xs"
                  aria-label="Shipping rows per page"
                  data-testid="shipping-page-size"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 / page</SelectItem>
                  <SelectItem value="20">20 / page</SelectItem>
                  <SelectItem value="50">50 / page</SelectItem>
                  <SelectItem value="100">100 / page</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* ── Scheduled Containers and Container Availability ── */}
        <ScheduledContainersTable />
        <ShippingAvailabilityTable />

        {/* ── Done / Hidden Containers ── */}
        <DoneContainersSection
          expanded={doneExpanded}
          onToggleExpanded={() => setDoneExpanded((v) => !v)}
          done={done}
          doneTotal={doneTotal}
          doneTotalPages={doneTotalPages}
          donePage={donePage}
          onDonePage={setDonePage}
          restorePending={restoreMutation.isPending}
          onView={setDocsRowId}
          onRestore={(id) => restoreMutation.mutate(id)}
          onDelete={setPendingDeleteId}
        />
      </div>

      {/* Hidden file input for shipping invoice upload */}
      <input
        ref={shippingInvoiceInputRef}
        type="file"
        accept="application/pdf,image/*"
        className="hidden"
        onChange={handleShippingInvoiceFileChange}
        data-testid="input-shipping-invoice-file"
      />

      {/* ── Dialogs ── */}
      <DocumentsModal
        open={!!docsRowId}
        rowId={docsRowId}
        invoiceNumber={docsRow?.invoiceNumber || ""}
        onClose={() => setDocsRowId(null)}
      />

      <WhatsAppModal
        open={!!waRowId}
        rowId={waRowId}
        onClose={() => setWaRowId(null)}
        onMarkDone={(id, markWaSent) => doneMutation.mutate({ id, markWaSent })}
      />

      <ShippingConfirmDialogs
        pendingDeleteId={pendingDeleteId}
        onCancelDelete={() => setPendingDeleteId(null)}
        onConfirmDelete={(id) => {
          deleteRowMutation.mutate(id);
          setPendingDeleteId(null);
        }}
        pendingDoneId={pendingDoneId}
        onCancelDone={() => setPendingDoneId(null)}
        onConfirmDone={(id) => {
          doneMutation.mutate({ id });
          setPendingDoneId(null);
        }}
      />
    </>
  );
}
