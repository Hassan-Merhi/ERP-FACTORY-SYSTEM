import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient as useTQClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Radio,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Settings2,
  Search,
  Package,
  Pencil,
  Ship,
  Truck,
  CheckCircle2,
  DollarSign,
  Clock,
  Filter,
  ChevronDown,
  Scale,
  Download,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useFactoryJsonCargoEta } from "./useFactoryJsonCargoEta";
import type { ContainerWithSupplier, OtwTrackingTabProps } from "./factoryotwtrackingtab/types";
import {
  STATUS_ACTIVE,
  calcDelayDays,
  ccySym,
  containerCost,
  fmtAmt,
  isOverdue,
  num,
} from "./factoryotwtrackingtab/utils";
import { SummaryCard } from "./factoryotwtrackingtab/components/SummaryCard";
import { EtaCell } from "./factoryotwtrackingtab/components/EtaCell";
import { NotesCell } from "./factoryotwtrackingtab/components/NotesCell";
import { EventTimelineSheet } from "./factoryotwtrackingtab/components/EventTimelineSheet";
import { TrackingSettingsSheet } from "./factoryotwtrackingtab/components/TrackingSettingsSheet";
import { TrackNowProgressLog } from "./factoryotwtrackingtab/components/TrackNowProgressLog";
import { useOtwCsvTools } from "./factoryotwtrackingtab/hooks/useOtwCsvTools";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";
export default function FactoryOtwTrackingTab({ onEdit }: OtwTrackingTabProps = {}) {
  const { toast } = useToast();
  const tqClient = useTQClient();
  const { data: currentUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const jsonCargoEta = useFactoryJsonCargoEta();
  const [trackingNowId, setTrackingNowId] = useState<number | null>(null);
  const [timelineId, setTimelineId] = useState<number | null>(null);
  const [settingsContainer, setSettingsContainer] = useState<ContainerWithSupplier | null>(null);
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [freightFilter, setFreightFilter] = useState<string>("all");
  const [weightFilter, setWeightFilter] = useState<string>("all");
  const [docsFilter, setDocsFilter] = useState<string>("all");
  const [delayedFilter, setDelayedFilter] = useState<string>("all");
  const [sortOrder, setSortOrder] = useState<string>("DEFAULT");
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  // Use activeOnly=true so the backend pre-filters to PENDING/IN_TRANSIT/ARRIVED.
  // The queryKey uses the base path so existing invalidations (prefix-match) still work.
  const { data: containers, isLoading } = useQuery<ContainerWithSupplier[]>({
    queryKey: ["/api/factory/containers", "otw"],
    queryFn: async () => {
      const res = await fetch("/api/factory/containers?activeOnly=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch containers");
      return res.json();
    },
  });
  const otwContainers = (containers || []).filter((c) => STATUS_ACTIVE.has(c.status));
  // Supplier list for filter
  const suppliers = Array.from(
    new Map(otwContainers.map((c) => [String(c.supplierId ?? "none"), c.supplierName || "No Supplier"])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));
  // Apply filters + sort
  let filtered = otwContainers.filter((c) => {
    if (supplierFilter !== "all" && String(c.supplierId ?? "none") !== supplierFilter) return false;
    if (freightFilter === "has_freight" && !(num(c.freight) > 0)) return false;
    if (freightFilter === "no_freight" && num(c.freight) > 0) return false;
    if (weightFilter === "has_weight" && !(num(c.totalKg) > 0)) return false;
    if (weightFilter === "no_weight" && num(c.totalKg) > 0) return false;
    if (docsFilter === "received" && !c.otwDocsReceived) return false;
    if (docsFilter === "not_received" && !!c.otwDocsReceived) return false;
    if (delayedFilter === "delayed" && calcDelayDays(c) === 0) return false;
    if (delayedFilter === "overdue" && !isOverdue(c)) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!c.containerNumber?.toLowerCase().includes(q) && !c.supplierName?.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  // Sort
  filtered = [...filtered].sort((a, b) => {
    if (sortOrder === "ETA_ASC" || sortOrder === "ETA_DESC") {
      const da = a.arrivalDate ? new Date(a.arrivalDate).getTime() : sortOrder === "ETA_ASC" ? Infinity : -Infinity;
      const db = b.arrivalDate ? new Date(b.arrivalDate).getTime() : sortOrder === "ETA_ASC" ? Infinity : -Infinity;
      if (da !== db) return sortOrder === "ETA_ASC" ? da - db : db - da;
    }
    const sa = (a.supplierName || "").toLowerCase();
    const sb = (b.supplierName || "").toLowerCase();
    return sa.localeCompare(sb);
  });
  // Summary stats
  const _pending = otwContainers.filter((c) => c.status === "PENDING").length;
  const inTransit = otwContainers.filter((c) => c.status === "IN_TRANSIT").length;
  const arrived = otwContainers.filter((c) => c.status === "ARRIVED").length;
  const delayed = otwContainers.filter((c) => calcDelayDays(c) > 0).length;
  const _withErrors = otwContainers.filter((c) => !!c.trackingError).length;
  const today = new Date().toDateString();
  const _checkedToday = otwContainers.filter((c) => {
    const fc = c;
    return fc.trackingLastCheckedAt && new Date(fc.trackingLastCheckedAt).toDateString() === today;
  }).length;
  // Cost totals grouped by currency
  const costByCurrency = filtered.reduce<Record<string, { symbol: string; amount: number }>>((acc, c) => {
    const { symbol, amount } = containerCost(c);
    const ccy = c.currencyCode || "USD";
    if (amount > 0) {
      if (!acc[ccy]) acc[ccy] = { symbol, amount: 0 };
      acc[ccy].amount += amount;
    }
    return acc;
  }, {});
  // Freight totals grouped by currency
  const freightByCurrency = filtered.reduce<Record<string, { symbol: string; amount: number }>>((acc, c) => {
    const freightAmt = num(c.freight);
    if (freightAmt <= 0) return acc;
    const ccy = c.freightCurrencyCode || c.currencyCode || "USD";
    const sym = ccySym(ccy);
    if (!acc[ccy]) acc[ccy] = { symbol: sym, amount: 0 };
    acc[ccy].amount += freightAmt;
    return acc;
  }, {});
  // Commission totals grouped by currency — there's no dedicated Commission KPI card;
  // instead its USD portion is folded into the "Total (USD)" card below so that card
  // represents the full USD balance (container cost + freight + commission), matching
  // how "Total (USD)" already implicitly combines cost-in-USD across containers.
  const commissionByCurrency = filtered.reduce<Record<string, { symbol: string; amount: number }>>((acc, c) => {
    const commAmt = num(c.commissionAmount);
    if (commAmt <= 0) return acc;
    const ccy = c.commissionCurrencyCode || "USD";
    const sym = ccySym(ccy);
    if (!acc[ccy]) acc[ccy] = { symbol: sym, amount: 0 };
    acc[ccy].amount += commAmt;
    return acc;
  }, {});
  // "Total (USD)" = USD-priced container cost + USD freight + USD commission.
  // Other currencies' Total cards are left as cost-only (freight/commission for those
  // currencies already appear on their own Freight (CCY) card, and commission has no
  // separate card at all, per request — its USD amount rolls into Total (USD) instead).
  const totalByCurrencyWithUsdBalance: Record<string, { symbol: string; amount: number }> = { ...costByCurrency };
  {
    const usdFreight = freightByCurrency.USD?.amount || 0;
    const usdCommission = commissionByCurrency.USD?.amount || 0;
    const extraUsd = usdFreight + usdCommission;
    if (extraUsd > 0) {
      const existing = totalByCurrencyWithUsdBalance.USD;
      totalByCurrencyWithUsdBalance.USD = {
        symbol: existing?.symbol || ccySym("USD"),
        amount: (existing?.amount || 0) + extraUsd,
      };
    }
  }
  const docsReceived = filtered.filter((c) => !!c.otwDocsReceived).length;
  const totalWeight = filtered.reduce((sum, c) => sum + num(c.totalKg), 0);
  const timelineContainer = otwContainers.find((c) => c.id === timelineId) ?? null;
  const trackingEnabledCount = otwContainers.filter((c) => c.trackingEnabled !== false).length;
  const _hasActiveFilters =
    search ||
    supplierFilter !== "all" ||
    freightFilter !== "all" ||
    weightFilter !== "all" ||
    docsFilter !== "all" ||
    delayedFilter !== "all" ||
    sortOrder !== "DEFAULT";
  /** Immediately patch the in-memory cache entry so the UI reflects the new
   *  value without waiting for the background refetch to complete. */
  function patchCacheContainer(id: number, patch: Partial<ContainerWithSupplier>) {
    tqClient.setQueriesData<ContainerWithSupplier[]>({ queryKey: ["/api/factory/containers"] }, (old) =>
      old?.map((c) => (c.id === id ? { ...c, ...patch } : c))
    );
  }
  async function saveNote(id: number, val: string) {
    try {
      await factoryApiRequest("PATCH", `/api/factory/containers/${id}`, { otwNote: val || null });
      patchCacheContainer(id, { otwNote: val || null });
      tqClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
    } catch (err) {
      toast({
        title: "Failed to save note",
        description: getErrorDetails(err).optionalMessage,
        variant: "destructive",
      });
    }
  }
  async function toggleDoc(id: number, checked: boolean) {
    try {
      await factoryApiRequest("PATCH", `/api/factory/containers/${id}`, { otwDocsReceived: checked });
      patchCacheContainer(id, { otwDocsReceived: checked });
      tqClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
    } catch (err) {
      toast({
        title: "Failed to update docs",
        description: getErrorDetails(err).optionalMessage,
        variant: "destructive",
      });
    }
  }
  const etaMutation = useMutation({
    mutationFn: async ({ id, arrivalDate }: { id: number; arrivalDate: string | null }) => {
      const res = await factoryApiRequest("PATCH", `/api/factory/containers/${id}`, {
        arrivalDate: arrivalDate || null,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed to update ETA");
      }
      return res.json();
    },
    onSuccess: (_data, variables) => {
      patchCacheContainer(variables.id, { arrivalDate: variables.arrivalDate });
      tqClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Failed to update ETA", description: err?.message, variant: "destructive" });
    },
  });
  function saveEta(id: number, val: string | null) {
    etaMutation.mutate({ id, arrivalDate: val });
  }
  function clearFilters() {
    setSearch("");
    setSupplierFilter("all");
    setFreightFilter("all");
    setWeightFilter("all");
    setDocsFilter("all");
    setDelayedFilter("all");
    setSortOrder("DEFAULT");
  }
  const trackNowMutation = useMutation({
    mutationFn: async (containerId: number) => {
      const res = await factoryApiRequest("POST", `/api/factory/container-tracking/${containerId}/track-now`, {});
      if (!res.ok) throw new Error("Failed to dispatch tracking");
      return containerId;
    },
    onMutate: (id) => setTrackingNowId(id),
    onSuccess: (_containerId) => {
      toast({ title: "Tracking started", description: "Fetching live data in the background…" });
      // Poll for updated container data while tracking runs in background
      let elapsed = 0;
      const POLL_MS = 4000;
      const MAX_MS = 28000;
      const interval = setInterval(() => {
        elapsed += POLL_MS;
        tqClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
        if (elapsed >= MAX_MS) {
          clearInterval(interval);
          setTrackingNowId(null);
        }
      }, POLL_MS);
    },
    onError: (err: ClientErrorLike) => {
      setTrackingNowId(null);
      toast({ title: "Tracking failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });
  const [bulkTracking, setBulkTracking] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const { importing, exportCsv, handleImportFile } = useOtwCsvTools(filtered, otwContainers);

  async function trackAll() {
    const eligible = otwContainers.filter((c) => {
      const fc = c;
      return fc.trackingEnabled !== false && /^[A-Z]{4}\d{7}$/.test((c.containerNumber || "").trim().toUpperCase());
    });
    if (eligible.length === 0) {
      toast({
        title: "No eligible containers",
        description: "All containers have tracking disabled or invalid numbers.",
      });
      return;
    }
    setBulkTracking(true);
    setBulkProgress({ done: 0, total: eligible.length });
    // Dispatch tracking requests with back-pressure: if the server is busy (429)
    // we pause briefly before retrying, preventing OOM from too many concurrent jobs.
    const RETRY_DELAY_MS = 4000;
    const MAX_RETRIES = 8;
    let queued = 0;
    for (let i = 0; i < eligible.length; i++) {
      const c = eligible[i];
      let retries = 0;
      while (retries <= MAX_RETRIES) {
        try {
          const res = await factoryApiRequest("POST", `/api/factory/container-tracking/${c.id}/track-now`, {});
          if (res.status === 429) {
            retries++;
            if (retries <= MAX_RETRIES) {
              await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
              continue;
            }
          } else {
            queued++;
          }
          break;
        } catch {
          break;
        }
      }
      setBulkProgress({ done: i + 1, total: eligible.length });
    }
    setBulkTracking(false);
    setBulkProgress(null);
    toast({
      title: `Tracking ${queued} of ${eligible.length} containers…`,
      description: "Results will appear automatically as each container is checked.",
    });
    // Poll for results as background tracking completes
    let elapsed = 0;
    const POLL_MS = 5000;
    const MAX_MS = 60000;
    const interval = setInterval(() => {
      elapsed += POLL_MS;
      tqClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      if (elapsed >= MAX_MS) clearInterval(interval);
    }, POLL_MS);
  }
  if (isLoading) {
    return (
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-16 w-36 rounded-lg border bg-muted animate-pulse" />
          ))}
        </div>
        <div className="h-48 rounded-lg border bg-muted animate-pulse" />
      </div>
    );
  }
  if (otwContainers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <Radio className="h-12 w-12 opacity-20" />
        <p className="text-sm">No containers currently on the way.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Summary Cards (ERP-style) ── */}
      <div className="flex flex-wrap gap-2">
        <SummaryCard
          label="Active"
          value={otwContainers.length}
          icon={<Package className="h-4 w-4 text-primary" />}
          accent="bg-primary/10"
        />
        {inTransit > 0 && (
          <SummaryCard
            label="In Transit"
            value={inTransit}
            icon={<Truck className="h-4 w-4 text-indigo-600" />}
            accent="bg-indigo-100 dark:bg-indigo-900/30"
          />
        )}
        {arrived > 0 && (
          <SummaryCard
            label="Arrived"
            value={arrived}
            icon={<CheckCircle2 className="h-4 w-4 text-green-600" />}
            accent="bg-green-100 dark:bg-green-900/30"
          />
        )}
        {delayed > 0 && (
          <SummaryCard
            label="Delayed"
            value={delayed}
            icon={<Clock className="h-4 w-4 text-red-600" />}
            accent="bg-red-100 dark:bg-red-900/30"
          />
        )}
        {totalWeight > 0 && (
          <SummaryCard
            label="Total Weight (KG)"
            value={Math.round(totalWeight).toLocaleString()}
            icon={<Scale className="h-4 w-4 text-violet-600" />}
            accent="bg-violet-100 dark:bg-violet-900/30"
          />
        )}
        {Object.entries(totalByCurrencyWithUsdBalance).map(([ccy, { symbol, amount }]) => (
          <SummaryCard
            key={ccy}
            label={ccy === "USD" ? "Total (USD) — cost + freight + commission" : `Total (${ccy})`}
            value={`${symbol} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            icon={<DollarSign className="h-4 w-4 text-emerald-600" />}
            accent="bg-emerald-100 dark:bg-emerald-900/30"
          />
        ))}
        {Object.entries(freightByCurrency).map(([ccy, { symbol, amount }]) => (
          <SummaryCard
            key={`freight-${ccy}`}
            label={`Freight (${ccy})`}
            value={`${symbol} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            icon={<Ship className="h-4 w-4 text-sky-600" />}
            accent="bg-sky-100 dark:bg-sky-900/30"
          />
        ))}
      </div>
      {/* ── Search + Filters Toggle + Track All ── */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search container #, supplier…"
            className="pl-8"
            data-testid="input-otw-search"
          />
        </div>
        <Button variant="outline" onClick={() => setShowFilters((v) => !v)} data-testid="button-otw-filters">
          <Filter className="h-4 w-4 mr-1" />
          Filters
          <ChevronDown className={cn("h-3.5 w-3.5 ml-1 transition-transform", showFilters && "rotate-180")} />
        </Button>
        <Button
          variant="outline"
          onClick={trackAll}
          disabled={bulkTracking || otwContainers.length === 0}
          data-testid="button-track-all-now"
        >
          {bulkTracking ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4 mr-1.5" />
          )}
          {bulkTracking
            ? bulkProgress
              ? `Tracking… ${bulkProgress.done}/${bulkProgress.total}`
              : "Tracking…"
            : `Track All${trackingEnabledCount > 0 ? ` (${trackingEnabledCount})` : ""}`}
        </Button>
        {currentUser?.role === "Developer" && (
          <>
            <Button
              variant="outline"
              onClick={() => jsonCargoEta.refreshBulk()}
              disabled={jsonCargoEta.bulkIsPending}
              title="JSONCargo ETA refresh — Maersk, Hapag-Lloyd, MSC, CMA CGM"
              data-testid="button-update-etas"
            >
              {jsonCargoEta.bulkIsPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-1.5" />
              )}
              Update ETAs
            </Button>
            <Button
              variant="outline"
              onClick={exportCsv}
              disabled={filtered.length === 0}
              title="Export filtered containers to CSV"
              data-testid="button-export-csv"
            >
              <Download className="h-4 w-4 mr-1.5" />
              Export CSV
            </Button>
            <Button
              variant="outline"
              disabled={importing}
              title="Import CSV to bulk-update ETA. Columns: Container #, Supplier, ETA (YYYY-MM-DD)"
              data-testid="button-import-csv"
              onClick={() => document.getElementById("otw-import-input")?.click()}
            >
              {importing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}
              Import CSV
            </Button>
            <input
              id="otw-import-input"
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={handleImportFile}
            />
          </>
        )}
      </div>
      {/* ── Expandable Filters Panel ── */}
      {showFilters && (
        <div className="flex flex-wrap gap-3 rounded-md border bg-muted/30 p-3">
          <div className="flex flex-col gap-1 min-w-[160px] flex-1">
            <p className="text-xs text-muted-foreground">Supplier</p>
            <Select value={supplierFilter} onValueChange={setSupplierFilter}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-supplier-filter">
                <SelectValue placeholder="All suppliers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All suppliers</SelectItem>
                {suppliers.map(([key, name]) => (
                  <SelectItem key={key} value={key}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 min-w-[130px] flex-1">
            <p className="text-xs text-muted-foreground">Freight</p>
            <Select value={freightFilter} onValueChange={setFreightFilter}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-freight-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All freight</SelectItem>
                <SelectItem value="has_freight">Has freight</SelectItem>
                <SelectItem value="no_freight">No freight</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 min-w-[130px] flex-1">
            <p className="text-xs text-muted-foreground">Weight</p>
            <Select value={weightFilter} onValueChange={setWeightFilter}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-weight-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All weights</SelectItem>
                <SelectItem value="has_weight">Has weight</SelectItem>
                <SelectItem value="no_weight">No weight</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 min-w-[130px] flex-1">
            <p className="text-xs text-muted-foreground">Docs</p>
            <Select value={docsFilter} onValueChange={setDocsFilter}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-docs-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All docs</SelectItem>
                <SelectItem value="received">Docs received</SelectItem>
                <SelectItem value="not_received">Docs pending</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 min-w-[130px] flex-1">
            <p className="text-xs text-muted-foreground">Delay / Overdue</p>
            <Select value={delayedFilter} onValueChange={setDelayedFilter}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-delayed-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="delayed">Delayed only</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1 min-w-[120px] flex-1">
            <p className="text-xs text-muted-foreground">Sort by ETA</p>
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className="h-8 text-xs" data-testid="select-sort-order">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="DEFAULT">Default</SelectItem>
                <SelectItem value="ETA_ASC">Oldest first</SelectItem>
                <SelectItem value="ETA_DESC">Newest first</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={clearFilters}
              data-testid="button-clear-filters"
            >
              Clear All
            </Button>
          </div>
        </div>
      )}
      {/* ── Results count + Legend ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-muted-foreground">
          Showing {filtered.length} of {otwContainers.length} active containers — click a row to edit
        </p>
        <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-red-200 dark:bg-red-900/40" />
            Overdue
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-sm bg-amber-200 dark:bg-amber-900/40" />
            Tracking Error
          </span>
          <span className="text-muted-foreground">{docsReceived} docs received</span>
        </div>
      </div>
      {/* ── Main Table ── */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <Radio className="h-10 w-10 opacity-30" />
          <p className="text-sm">No containers match your filters.</p>
        </div>
      ) : (
        <Table className="text-xs whitespace-nowrap" wrapperClassName="max-h-[calc(100vh-340px)] overflow-x-auto">
          <TableHeader className="sticky top-0 z-10">
            <TableRow className="!bg-amber-100 dark:!bg-amber-900/40">
              <TableHead className="w-8">#</TableHead>
              <TableHead>Container #</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>ETA</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Freight</TableHead>
              <TableHead className="text-right">Commission</TableHead>
              <TableHead className="text-right">Duty</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Weight (kg)</TableHead>
              <TableHead>Delayed</TableHead>
              <TableHead>Docs</TableHead>
              <TableHead className="min-w-[140px]">Notes</TableHead>
              <TableHead className="w-24 text-right pr-3">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((c, idx) => {
              const fc = c;
              const cost = containerCost(c);
              const frSym = ccySym(c.freightCurrencyCode || c.currencyCode);
              const commSym = ccySym(c.commissionCurrencyCode || "USD");
              const dutySym = ccySym(c.currencyCode);
              const docDone = !!c.otwDocsReceived;
              const isTracking = trackingNowId === c.id;
              const hasError = !!fc.trackingError;
              const isEnabled = fc.trackingEnabled !== false;
              const isValidNum = /^[A-Z]{4}\d{7}$/.test((c.containerNumber || "").trim().toUpperCase());
              const delayDays = calcDelayDays(c);
              const overdue = isOverdue(c);
              const location = fc.trackingLastLocation || c.destination || null;
              const rowBg = overdue
                ? "bg-red-50/50 dark:bg-red-950/20"
                : hasError
                  ? "bg-amber-50/50 dark:bg-amber-950/20"
                  : "";
              return (
                <TableRow
                  key={c.id}
                  className={cn("cursor-pointer", rowBg)}
                  onClick={() => setTimelineId(c.id)}
                  data-testid={`row-otw-container-${c.id}`}
                >
                  {/* # */}
                  <TableCell className="text-muted-foreground">{idx + 1}</TableCell>
                  {/* Container # */}
                  <TableCell className="font-mono font-medium">
                    <div className="flex flex-col gap-0.5">
                      <span>{c.containerNumber || "—"}</span>
                      {isTracking && <TrackNowProgressLog containerId={c.id} />}
                      {fc.trackingLastCheckedAt && (
                        <span className="text-xs text-muted-foreground font-normal">
                          {new Date(fc.trackingLastCheckedAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      )}
                      {!isValidNum && (
                        <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Invalid format
                        </span>
                      )}
                    </div>
                  </TableCell>

                  {/* Supplier */}
                  <TableCell>{fc.supplierName ?? <span className="text-muted-foreground">—</span>}</TableCell>

                  {/* ETA */}
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <EtaCell containerId={c.id} arrivalDate={c.arrivalDate} overdue={overdue} onSave={saveEta} />
                  </TableCell>

                  {/* Cost */}
                  <TableCell className="text-right font-medium">
                    {cost.amount > 0 ? (
                      fmtAmt(cost.symbol, cost.amount)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  {/* Freight */}
                  <TableCell className="text-right text-muted-foreground">
                    {num(c.freight) > 0 ? (
                      fmtAmt(frSym, num(c.freight))
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  {/* Commission */}
                  <TableCell className="text-right text-muted-foreground">
                    {num(c.commissionAmount) > 0 ? (
                      fmtAmt(commSym, num(c.commissionAmount))
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  {/* Duty */}
                  <TableCell className="text-right text-muted-foreground">
                    {num(c.dutyAmount) > 0 ? (
                      fmtAmt(dutySym, num(c.dutyAmount))
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  {/* Location */}
                  <TableCell>{location ?? <span className="text-muted-foreground">—</span>}</TableCell>

                  {/* Weight */}
                  <TableCell className="text-muted-foreground">
                    {c.totalKg ? (
                      Number(c.totalKg).toLocaleString(undefined, { maximumFractionDigits: 0 })
                    ) : (
                      <span>—</span>
                    )}
                  </TableCell>

                  {/* Delayed */}
                  <TableCell>
                    {delayDays > 0 ? (
                      <span className="text-red-600 dark:text-red-400 font-medium">-{delayDays}d</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  {/* Docs */}
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={docDone}
                      onCheckedChange={(v) => toggleDoc(c.id, !!v)}
                      data-testid={`checkbox-docs-${c.id}`}
                      aria-label="Docs received"
                    />
                  </TableCell>

                  {/* Notes */}
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <NotesCell containerId={c.id} note={c.otwNote ?? ""} onSave={saveNote} />
                  </TableCell>

                  {/* Actions */}
                  <TableCell className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-0.5">
                      {onEdit && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => onEdit(c)}
                              data-testid={`button-otw-edit-${c.id}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit Container</TooltipContent>
                        </Tooltip>
                      )}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setSettingsContainer(c)}
                            data-testid={`button-otw-settings-${c.id}`}
                          >
                            <Settings2 className="h-3.5 w-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Tracking Settings</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={isTracking || !isEnabled || !isValidNum}
                            onClick={() => trackNowMutation.mutate(c.id)}
                            data-testid={`button-otw-track-now-${c.id}`}
                          >
                            {isTracking ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {!isEnabled ? "Tracking disabled" : !isValidNum ? "Invalid container # format" : "Track Now"}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={jsonCargoEta.refreshingIds.has(c.id)}
                            onClick={() => jsonCargoEta.refreshOne(c.id)}
                            data-testid={`button-otw-refresh-eta-${c.id}`}
                          >
                            {jsonCargoEta.refreshingIds.has(c.id) ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Ship className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Refresh ETA (JSONCargo)</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* ── Sheets ── */}
      <EventTimelineSheet
        containerId={timelineId}
        containerNumber={timelineContainer?.containerNumber ?? ""}
        open={!!timelineId}
        onClose={() => setTimelineId(null)}
      />
      <TrackingSettingsSheet
        container={settingsContainer}
        open={!!settingsContainer}
        onClose={() => setSettingsContainer(null)}
      />
    </div>
  );
}
