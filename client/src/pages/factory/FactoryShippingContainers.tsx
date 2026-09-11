import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Search,
  Filter,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  MessageCircle,
  Eye,
  Trash2,
  RotateCcw,
  Check,
  RefreshCw,
  Loader2,
  SlidersHorizontal,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useLocation } from "wouter";

import type { DisplayRow, ShippingRow, TrackingRow } from "./factoryshippingcontainers/types";
import {
  CLI_LEFT,
  CTR_LEFT,
  INV_LEFT,
  LIST_KEY,
  SHIPPING_COLS,
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
import { useShippingColumnVisibility } from "./factoryshippingcontainers/hooks/useShippingColumnVisibility";

export default function FactoryShippingContainers() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [filterDocs, setFilterDocs] = useState<"all" | "has" | "missing">("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);
  const [docsRowId, setDocsRowId] = useState<number | null>(null);
  const [waRowId, setWaRowId] = useState<number | null>(null);
  const shippingInvoiceInputRef = useRef<HTMLInputElement>(null);
  const trackingRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shippingInvoiceUploadingId, setShippingInvoiceUploadingId] = useState<number | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [donePage, setDonePage] = useState(1);
  const [pendingDoneId, setPendingDoneId] = useState<number | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  interface AuthMe {
    id: number;
    currentCompanyId?: number | null;
    companyId?: number | null;
  }
  const { data: me } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const { colVis, toggleCol, hiddenCount } = useShippingColumnVisibility(me?.id);

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

  const trackAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/factory/shipping-containers/track-now");
      return (await res.json()) as { message?: string };
    },
    onSuccess: (data: { message?: string }) => {
      toast({ title: "Tracking started", description: data?.message ?? "ETA updates will appear shortly." });
      if (trackingRefreshTimerRef.current) clearTimeout(trackingRefreshTimerRef.current);
      trackingRefreshTimerRef.current = setTimeout(() => {
        trackingRefreshTimerRef.current = null;
        if (document.visibilityState !== "visible") return;
        queryClient.invalidateQueries(
          { queryKey: ["/api/factory/invoice-container-tracking"], exact: true, refetchType: "active" },
          { cancelRefetch: false }
        );
      }, 8000);
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Tracking failed", description: err.message, variant: "destructive" }),
  });

  useEffect(
    () => () => {
      if (trackingRefreshTimerRef.current) clearTimeout(trackingRefreshTimerRef.current);
    },
    []
  );

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

  const _deleteShippingInvoiceMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `${LIST_KEY}/${id}/shipping-invoice`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [LIST_KEY] });
      toast({ title: "Shipping invoice removed" });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Remove failed", description: e.message, variant: "destructive" }),
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

  // ── Filtering ─────────────────────────────────────────────────────────────────
  const filtered = useMemo(
    () =>
      allDisplayRows.filter((r) => {
        if (search) {
          const q = search.toLowerCase();
          if (
            !(r.invoiceNumber || "").toLowerCase().includes(q) &&
            !(r.clientName || "").toLowerCase().includes(q) &&
            !(r.containerNumber || "").toLowerCase().includes(q) &&
            !(r.destination || "").toLowerCase().includes(q) &&
            !(r.shippingCompany || "").toLowerCase().includes(q)
          )
            return false;
        }
        if (filterDocs === "has" && r.documentCount === 0) return false;
        if (filterDocs === "missing" && r.documentCount > 0) return false;
        if (filterStatus !== "all") {
          const effectiveStatus = r.status === "PENDING_VERIFICATION" ? "VERIFIED" : r.status;
          if (effectiveStatus !== filterStatus) return false;
        }
        return true;
      }),
    [allDisplayRows, search, filterDocs, filterStatus]
  );

  const hasActiveFilters = filterDocs !== "all" || filterStatus !== "all";

  return (
    <>
      <div className="space-y-4">
        {/* ── Top Controls ── */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search invoice, client, container, destination…"
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-search"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => trackAllMutation.mutate()}
            disabled={trackAllMutation.isPending}
            data-testid="button-track-all-eta"
          >
            {trackAllMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            {trackAllMutation.isPending ? "Tracking…" : "Track All ETAs"}
          </Button>
          <Button
            variant={showFilters ? "secondary" : "outline"}
            onClick={() => setShowFilters((v) => !v)}
            data-testid="button-toggle-filters"
          >
            <Filter className="h-4 w-4 mr-1" />
            Filters
            {hasActiveFilters && <span className="ml-1 h-2 w-2 rounded-full bg-primary inline-block" />}
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" data-testid="button-toggle-columns">
                <SlidersHorizontal className="h-4 w-4 mr-1" />
                Columns
                {hiddenCount > 0 && (
                  <span className="ml-1 text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 leading-none">
                    {hiddenCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
                Show / Hide Columns
              </p>
              <div className="space-y-0.5">
                {SHIPPING_COLS.map((col) => (
                  <label
                    key={col.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover-elevate cursor-pointer text-sm"
                    data-testid={`col-toggle-${col.id}`}
                  >
                    <Checkbox checked={colVis[col.id]} onCheckedChange={() => toggleCol(col.id)} />
                    {col.label}
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {/* ── Filter Panel ── */}
        {showFilters && (
          <div className="flex flex-wrap gap-3 items-center p-3 rounded-md border bg-muted/30">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Documents</p>
              <Select value={filterDocs} onValueChange={(v) => {
                  if (v === "all" || v === "has" || v === "missing") setFilterDocs(v);
                }}>
                <SelectTrigger className="h-8 text-xs w-36" data-testid="select-filter-docs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="has">Has Documents</SelectItem>
                  <SelectItem value="missing">Missing Documents</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Status</p>
              <Select value={filterStatus} onValueChange={setFilterStatus}>
                <SelectTrigger className="h-8 text-xs w-44" data-testid="select-filter-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="LOADING">Loading</SelectItem>
                  <SelectItem value="VERIFIED">Verified</SelectItem>
                  <SelectItem value="FINALIZED">Finalized</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => {
                  setFilterDocs("all");
                  setFilterStatus("all");
                }}
                data-testid="button-clear-filters"
              >
                Clear All
              </Button>
            </div>
          </div>
        )}

        {/* ── Legend ── */}
        <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> Has documents
          </span>
          <span className="flex items-center gap-1">
            <XCircle className="h-3.5 w-3.5 text-red-500" /> No documents
          </span>
          <span>Click editable cells (Container #, Destination, ETA, Shipping Co., Note, Arrived) to edit inline.</span>
        </div>

        {/* ── Main Table ── */}
        <div className="rounded-md border">
          <Table
            className="text-xs"
            style={{ minWidth: "1100px" }}
            wrapperClassName="max-h-[calc(100vh-300px)] overflow-auto"
          >
            <TableHeader>
              <TableRow>
                {colVis.orderDate && <TableHead className="text-xs w-20 min-w-[80px]">Order Date</TableHead>}
                <TableHead className={stickyHeadBase} style={{ left: INV_LEFT, minWidth: "130px", width: "130px" }}>
                  Invoice #
                </TableHead>
                <TableHead className={stickyHeadBase} style={{ left: CLI_LEFT, minWidth: "144px", width: "144px" }}>
                  Client
                </TableHead>
                {colVis.status && <TableHead className="text-xs w-24 min-w-[96px]">Status</TableHead>}
                <TableHead className={stickyHeadBase} style={{ left: CTR_LEFT, minWidth: "120px", width: "120px" }}>
                  Container #
                </TableHead>
                {colVis.destination && <TableHead className="text-xs min-w-[120px]">Destination</TableHead>}
                {colVis.eta && <TableHead className="text-xs min-w-[100px]">ETA</TableHead>}
                {colVis.arrived && <TableHead className="text-xs min-w-[90px]">Arrived</TableHead>}
                {colVis.finalized && <TableHead className="text-xs min-w-[90px]">Finalized</TableHead>}
                {colVis.shippingCo && <TableHead className="text-xs min-w-[110px]">Shipping Co.</TableHead>}
                {colVis.documents && <TableHead className="text-xs min-w-[90px]">Documents</TableHead>}
                {colVis.containerCost && <TableHead className="text-xs min-w-[100px]">Container Cost</TableHead>}
                {colVis.ciNumber && <TableHead className="text-xs min-w-[100px]">CI No.</TableHead>}
                {colVis.note && <TableHead className="text-xs min-w-[110px]">Note</TableHead>}
                {colVis.whatsapp && <TableHead className="text-xs min-w-[90px]">WhatsApp</TableHead>}
                {colVis.done && <TableHead className="text-xs min-w-[80px]">Done</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={17} className="text-center py-10 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={17} className="text-center py-10 text-muted-foreground">
                    {allDisplayRows.length === 0 ? "No active records." : "No records match the current filters."}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((r) => (
                  <TableRow key={r.id} data-testid={`row-record-${r.id}`}>
                    {colVis.orderDate && (
                      <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.orderDate)}</TableCell>
                    )}

                    {/* Sticky: Invoice # */}
                    <TableCell className={stickyCellBase} style={{ left: INV_LEFT }}>
                      <span className="font-mono font-medium text-xs whitespace-nowrap">{r.invoiceNumber}</span>
                    </TableCell>

                    {/* Sticky: Client */}
                    <TableCell
                      className={cn(stickyCellBase, "font-medium text-xs max-w-[144px] truncate")}
                      style={{ left: CLI_LEFT }}
                    >
                      {r.clientName || "—"}
                    </TableCell>

                    {colVis.status && (
                      <TableCell>
                        <button
                          className="focus:outline-none"
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
                          <Badge className={cn("text-xs whitespace-nowrap cursor-pointer", statusColor(r.status))}>
                            {statusLabel(r.status)}
                          </Badge>
                        </button>
                      </TableCell>
                    )}

                    {/* Sticky: Container # */}
                    <TableCell className={stickyCellBase} style={{ left: CTR_LEFT }}>
                      <EditableCellInput
                        value={r.containerNumber || ""}
                        placeholder="Enter #"
                        onSave={(v) => syncOrderMutation.mutate({ id: r.id, patch: { containerNumber: v || null } })}
                        testId={`cell-container-${r.id}`}
                        saving={syncOrderMutation.isPending}
                      />
                    </TableCell>

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
                          <span className="text-green-700 dark:text-green-400 font-medium text-xs">
                            {fmtDate(r.finalizedDate)}
                          </span>
                        ) : (
                          <span className="text-amber-600 dark:text-amber-400 italic text-xs">Not finalized</span>
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
                          <span className="text-foreground">${Number(r.grandTotal).toLocaleString()}</span>
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
        </div>

        {/* ── Container Availability ── */}
        <ShippingAvailabilityTable />

        {/* ── Done / Hidden Containers ── */}
        <div className="rounded-md border overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-muted-foreground hover-elevate bg-muted/20"
            onClick={() => setDoneExpanded((v) => !v)}
            data-testid="button-toggle-done"
          >
            <span className="flex items-center gap-2">
              {doneExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Done / Hidden Containers
              <Badge variant="outline" className="text-xs">
                {doneTotal}
              </Badge>
            </span>
            <span className="text-xs">Collapse to keep workspace clean</span>
          </button>

          {doneExpanded &&
            (done.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">No done containers yet.</div>
            ) : (
              <div>
                <div className="overflow-x-auto">
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Invoice #</TableHead>
                        <TableHead className="text-xs">Client</TableHead>
                        <TableHead className="text-xs">Container #</TableHead>
                        <TableHead className="text-xs">Destination</TableHead>
                        <TableHead className="text-xs">Done Date</TableHead>
                        <TableHead className="text-xs">WA Sent</TableHead>
                        <TableHead className="text-xs">Done By</TableHead>
                        <TableHead className="w-28" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {done.map((r) => (
                        <TableRow key={r.id} className="opacity-70" data-testid={`row-done-${r.id}`}>
                          <TableCell className="font-mono">{r.invoiceNumber}</TableCell>
                          <TableCell>{r.clientName || "—"}</TableCell>
                          <TableCell className="font-mono">{r.containerNumber || "—"}</TableCell>
                          <TableCell>{r.destination || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{fmtDate(r.doneAt)}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            {r.whatsappSentAt ? (
                              <span className="text-green-700 dark:text-green-400">{fmtDate(r.whatsappSentAt)}</span>
                            ) : (
                              <span className="text-muted-foreground italic">—</span>
                            )}
                          </TableCell>
                          <TableCell>{r.doneBy || "—"}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setDocsRowId(r.id)}
                                data-testid={`button-view-done-${r.id}`}
                              >
                                <Eye className="h-3.5 w-3.5 mr-1" /> View
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={restoreMutation.isPending}
                                onClick={() => restoreMutation.mutate(r.id)}
                                data-testid={`button-restore-${r.id}`}
                              >
                                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Restore
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setPendingDeleteId(r.id)}
                                data-testid={`button-delete-done-${r.id}`}
                              >
                                <Trash2 className="h-3.5 w-3.5 text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {doneTotalPages > 1 && (
                  <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
                    <span>
                      Page {donePage} of {doneTotalPages} · {doneTotal} completed containers
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={donePage <= 1}
                        onClick={() => setDonePage((page) => Math.max(1, page - 1))}
                        data-testid="button-done-prev-page"
                      >
                        Previous
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={donePage >= doneTotalPages}
                        onClick={() => setDonePage((page) => Math.min(doneTotalPages, page + 1))}
                        data-testid="button-done-next-page"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>
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

      {/* Confirm delete */}
      <AlertDialog
        open={!!pendingDeleteId}
        onOpenChange={(v) => {
          if (!v) setPendingDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the shipping container record and all its attached documents. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => {
                if (pendingDeleteId) {
                  deleteRowMutation.mutate(pendingDeleteId);
                  setPendingDeleteId(null);
                }
              }}
              data-testid="button-confirm-delete-row"
            >
              Yes, Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm before marking done */}
      <AlertDialog
        open={!!pendingDoneId}
        onOpenChange={(v) => {
          if (!v) setPendingDoneId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark as Done?</AlertDialogTitle>
            <AlertDialogDescription>
              This will move the shipment to the Done / Hidden section. You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDoneId) {
                  doneMutation.mutate({ id: pendingDoneId });
                  setPendingDoneId(null);
                }
              }}
              data-testid="button-confirm-done"
            >
              Yes, Mark as Done
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
