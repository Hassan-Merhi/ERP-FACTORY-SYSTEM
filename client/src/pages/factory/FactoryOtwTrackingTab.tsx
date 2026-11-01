import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient as useTQClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Radio,
  Loader2,
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
  Copy,
  RefreshCcw,
  CalendarDays,
  LayoutList,
  AlertTriangle,
  FileCheck2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
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
import { useOtwCsvTools } from "./factoryotwtrackingtab/hooks/useOtwCsvTools";
import type { AuthMe } from "@shared/apiTypes";
export default function FactoryOtwTrackingTab({ onEdit }: OtwTrackingTabProps = {}) {
  const { toast } = useToast();
  const tqClient = useTQClient();
  const { data: currentUser } = useQuery<AuthMe>({ queryKey: ["/api/auth/me"] });
  const [supplierFilter, setSupplierFilter] = useState<string>("all");
  const [freightFilter, setFreightFilter] = useState<string>("all");
  const [weightFilter, setWeightFilter] = useState<string>("all");
  const [docsFilter, setDocsFilter] = useState<string>("all");
  const [delayedFilter, setDelayedFilter] = useState<string>("all");
  const [sortOrder, setSortOrder] = useState<string>("DEFAULT");
  const [search, setSearch] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [detailedView, setDetailedView] = useState(false);
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
    if (delayedFilter === "on_time" && (!c.arrivalDate || isOverdue(c))) return false;
    if (delayedFilter === "eta_missing" && !!c.arrivalDate) return false;
    if (search.trim()) {
      if (!searchAny(search, c.containerNumber, c.supplierName)) return false;
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
  const inTransit = otwContainers.filter((c) => c.status === "IN_TRANSIT").length;
  const arrived = otwContainers.filter((c) => c.status === "ARRIVED").length;
  const delayed = otwContainers.filter((c) => calcDelayDays(c) > 0).length;
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
  const onTime = otwContainers.filter((c) => !!c.arrivalDate && !isOverdue(c)).length;
  const missingEta = otwContainers.filter((c) => !c.arrivalDate).length;
  const activeFilterCount = [supplierFilter, freightFilter, weightFilter, docsFilter, delayedFilter].filter((v) => v !== "all").length + (search.trim() ? 1 : 0) + (sortOrder !== "DEFAULT" ? 1 : 0);
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
  const { importing, exportCsv, handleImportFile } = useOtwCsvTools(filtered, otwContainers);

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
    <div className="flex min-w-0 flex-col gap-4 pb-6">
      <header className="relative isolate overflow-hidden rounded-2xl border border-blue-200/50 bg-gradient-to-r from-slate-50 via-blue-50/70 to-sky-100/60 p-5 shadow-sm dark:border-blue-400/15 dark:from-[#0c192d] dark:via-[#0e2037] dark:to-[#0b2641] sm:p-6">
        <div className="pointer-events-none absolute -right-12 -top-12 h-52 w-72 rounded-full bg-blue-500/15 blur-3xl" />
        <Ship className="pointer-events-none absolute -bottom-4 right-10 hidden h-36 w-36 text-blue-500/10 lg:block" strokeWidth={1} />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-blue-500/30 bg-blue-500/15 shadow-lg shadow-blue-500/10">
              <Truck className="h-7 w-7 text-blue-600 dark:text-blue-300" />
            </div>
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">OTW Tracking</h2>
                <span className="rounded-full border border-blue-400/20 bg-blue-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-200">Incoming shipments</span>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-300">Container visibility, delays, ETAs and documents in one place.</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-2 rounded-xl border border-slate-300/40 bg-white/50 px-3 py-2 text-xs text-slate-600 dark:border-white/10 dark:bg-slate-950/25 dark:text-slate-300">
            <CalendarDays className="h-4 w-4 text-blue-500" /> Active shipment overview
          </span>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <SummaryCard label="Active containers" value={otwContainers.length} icon={<Package className="h-5 w-5 text-blue-500" />} accent="bg-blue-500/10" helper="Currently tracked" />
        <SummaryCard label="In transit" value={inTransit} icon={<Truck className="h-5 w-5 text-cyan-500" />} accent="bg-cyan-500/10" helper={arrived + " arrived"} />
        <SummaryCard label="Delayed" value={delayed} icon={<Clock className="h-5 w-5 text-red-500" />} accent="bg-red-500/10" helper="Past ETA date" />
        <SummaryCard label="Total weight" value={Math.round(totalWeight).toLocaleString() + " KG"} icon={<Scale className="h-5 w-5 text-violet-500" />} accent="bg-violet-500/10" helper="Filtered containers" />
        {Object.entries(totalByCurrencyWithUsdBalance).map(([ccy, item]) => (
          <SummaryCard key={"total-" + ccy} label={"Total (" + ccy + ")"} value={fmtAmt(item.symbol, item.amount)}
            icon={<DollarSign className="h-5 w-5 text-emerald-500" />} accent="bg-emerald-500/10"
            helper={ccy === "USD" ? "Cost + freight + commission" : "Container cost"} />
        ))}
        {Object.entries(freightByCurrency).map(([ccy, item]) => (
          <SummaryCard key={"freight-" + ccy} label={"Freight (" + ccy + ")"} value={fmtAmt(item.symbol, item.amount)}
            icon={<Ship className="h-5 w-5 text-sky-500" />} accent="bg-sky-500/10" helper="Filtered containers" />
        ))}
      </div>

      <section aria-label="OTW search and filters" className="rounded-2xl border border-border/70 bg-card p-3 shadow-sm sm:p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[210px] flex-[2_1_320px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search container # or supplier..."
              className="h-10 rounded-xl bg-background/80 pl-10" data-testid="input-otw-search" />
          </div>
          <div className="min-w-[150px] flex-[1_1_155px]">
            <Select value={supplierFilter} onValueChange={setSupplierFilter}>
              <SelectTrigger className="h-10 rounded-xl" data-testid="select-supplier-filter"><SelectValue placeholder="All suppliers" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All suppliers</SelectItem>
                {suppliers.map(([key, name]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[130px] flex-[1_1_135px]">
            <Select value={delayedFilter} onValueChange={setDelayedFilter}>
              <SelectTrigger className="h-10 rounded-xl" data-testid="select-delayed-filter"><SelectValue placeholder="All statuses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="on_time">On time</SelectItem>
                <SelectItem value="delayed">Delayed</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="eta_missing">ETA missing</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-[135px] flex-[1_1_145px]">
            <Select value={sortOrder} onValueChange={setSortOrder}>
              <SelectTrigger className="h-10 rounded-xl" data-testid="select-sort-order"><CalendarDays className="mr-1 h-4 w-4 shrink-0 text-muted-foreground" /><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="DEFAULT">Default order</SelectItem>
                <SelectItem value="ETA_ASC">Earliest ETA</SelectItem>
                <SelectItem value="ETA_DESC">Latest ETA</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" className="h-10 rounded-xl" onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters} data-testid="button-otw-filters">
            <Filter className="mr-1.5 h-4 w-4" /> Filters
            {activeFilterCount > 0 && <span className="ml-1.5 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] leading-none text-white">{activeFilterCount}</span>}
            <ChevronDown className={cn("ml-1.5 h-3.5 w-3.5 transition-transform", showFilters && "rotate-180")} />
          </Button>
          <Button variant="ghost" className="h-10 rounded-xl" onClick={clearFilters} data-testid="button-clear-filters">
            <RefreshCcw className="mr-1.5 h-4 w-4" /> Reset
          </Button>
        </div>
        {showFilters && (
          <div className="mt-3 grid grid-cols-1 gap-3 rounded-xl border border-border/60 bg-muted/20 p-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Freight</p>
              <Select value={freightFilter} onValueChange={setFreightFilter}>
                <SelectTrigger className="h-9" data-testid="select-freight-filter"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">All freight</SelectItem><SelectItem value="has_freight">Has freight</SelectItem><SelectItem value="no_freight">No freight</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Weight</p>
              <Select value={weightFilter} onValueChange={setWeightFilter}>
                <SelectTrigger className="h-9" data-testid="select-weight-filter"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">All weights</SelectItem><SelectItem value="has_weight">Has weight</SelectItem><SelectItem value="no_weight">No weight</SelectItem></SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Documents</p>
              <Select value={docsFilter} onValueChange={setDocsFilter}>
                <SelectTrigger className="h-9" data-testid="select-docs-filter"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">All documents</SelectItem><SelectItem value="received">Docs received</SelectItem><SelectItem value="not_received">Docs pending</SelectItem></SelectContent>
              </Select>
            </div>
            {currentUser?.role === "Developer" && (
              <div className="flex flex-wrap gap-2 sm:col-span-3">
                <Button variant="outline" className="h-9" onClick={exportCsv} disabled={filtered.length === 0} data-testid="button-export-csv">
                  <Download className="mr-1.5 h-4 w-4" /> Export CSV
                </Button>
                <Button variant="outline" className="h-9" disabled={importing}
                  title="Import CSV to bulk-update ETA. Columns: Container #, Supplier, ETA (YYYY-MM-DD)"
                  data-testid="button-import-csv" onClick={() => document.getElementById("otw-import-input")?.click()}>
                  {importing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />} Import CSV
                </Button>
                <input id="otw-import-input" type="file" accept=".csv,.txt" className="hidden" onChange={handleImportFile} />
              </div>
            )}
          </div>
        )}
      </section>

      <section aria-label="OTW container list" className="min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span><strong className="text-foreground">{filtered.length}</strong> of {otwContainers.length} active containers</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-emerald-500" />On time {onTime}</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-red-500" />Overdue {delayed}</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" />No ETA {missingEta}</span>
            <span className="inline-flex items-center gap-1.5"><FileCheck2 className="h-3.5 w-3.5 text-blue-500" />Docs {docsReceived}/{filtered.length}</span>
          </div>
          <Button variant={detailedView ? "secondary" : "outline"} size="sm" className="h-8 rounded-lg"
            onClick={() => setDetailedView((v) => !v)} aria-pressed={detailedView} data-testid="button-otw-detailed-view">
            <LayoutList className="mr-1.5 h-4 w-4" /> {detailedView ? "Compact view" : "Detailed view"}
          </Button>
        </div>
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
            <Radio className="h-9 w-9 opacity-30" /><p className="text-sm">No containers match your filters.</p>
            <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>
          </div>
        ) : (
          <Table mobileLayout="cards" className="text-xs whitespace-nowrap" wrapperClassName="overflow-x-auto">
            <TableHeader className="sticky top-0 z-10">
              <TableRow className="bg-slate-100/90 hover:bg-slate-100/90 dark:bg-[#15273e] dark:hover:bg-[#15273e]">
                <TableHead className="w-10 font-semibold">#</TableHead>
                <TableHead className="font-semibold">Container #</TableHead>
                <TableHead className="font-semibold">Supplier</TableHead>
                <TableHead className="font-semibold">ETA</TableHead>
                <TableHead className="text-right font-semibold">Cost</TableHead>
                <TableHead className="text-right font-semibold">Freight</TableHead>
                {detailedView && <TableHead className="text-right font-semibold">Commission</TableHead>}
                {detailedView && <TableHead className="text-right font-semibold">Duty</TableHead>}
                {detailedView && <TableHead className="font-semibold">Location</TableHead>}
                <TableHead className="text-right font-semibold">Weight (KG)</TableHead>
                <TableHead className="font-semibold">Delayed</TableHead>
                <TableHead className="text-center font-semibold">Docs</TableHead>
                <TableHead className="min-w-[150px] font-semibold">Notes</TableHead>
                <TableHead className="w-20 text-right font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((c, idx) => {
                const cost = containerCost(c);
                const frSym = ccySym(c.freightCurrencyCode || c.currencyCode);
                const commSym = ccySym(c.commissionCurrencyCode || "USD");
                const dutySym = ccySym(c.currencyCode);
                const delayDays = calcDelayDays(c);
                const overdue = isOverdue(c);
                return (
                  <TableRow key={c.id}
                    className={cn("border-b border-border/45 transition-colors hover:bg-blue-500/[0.035] dark:hover:bg-blue-400/[0.07]", overdue && "border-l-2 border-l-red-500/70")}
                    data-testid={"row-otw-container-" + c.id}>
                    <TableCell className="py-3 text-muted-foreground">{idx + 1}</TableCell>
                    <TableCell className="py-3 font-mono font-semibold text-foreground">{c.containerNumber || "—"}</TableCell>
                    <TableCell className="py-3 font-medium text-foreground/85">{c.supplierName || "—"}</TableCell>
                    <TableCell className="py-3" onClick={(e) => e.stopPropagation()}>
                      <EtaCell containerId={c.id} arrivalDate={c.arrivalDate} overdue={overdue} onSave={saveEta} />
                    </TableCell>
                    <TableCell className="py-3 text-right font-semibold tabular-nums">{cost.amount > 0 ? fmtAmt(cost.symbol, cost.amount) : "—"}</TableCell>
                    <TableCell className="py-3 text-right tabular-nums text-muted-foreground">{num(c.freight) > 0 ? fmtAmt(frSym, num(c.freight)) : "—"}</TableCell>
                    {detailedView && <TableCell className="py-3 text-right tabular-nums text-muted-foreground">{num(c.commissionAmount) > 0 ? fmtAmt(commSym, num(c.commissionAmount)) : "—"}</TableCell>}
                    {detailedView && <TableCell className="py-3 text-right tabular-nums text-muted-foreground">{num(c.dutyAmount) > 0 ? fmtAmt(dutySym, num(c.dutyAmount)) : "—"}</TableCell>}
                    {detailedView && <TableCell className="py-3 text-muted-foreground">{c.destination || "—"}</TableCell>}
                    <TableCell className="py-3 text-right tabular-nums text-foreground/80">{c.totalKg ? Number(c.totalKg).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}</TableCell>
                    <TableCell className="py-3">
                      {delayDays > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-red-500/10 px-2 py-1 font-semibold text-red-700 dark:text-red-300"><Clock className="h-3 w-3" />{delayDays}d</span>
                      ) : c.arrivalDate ? (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2 py-1 font-medium text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" />On time</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-lg bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-300"><AlertTriangle className="h-3 w-3" />No ETA</span>
                      )}
                    </TableCell>
                    <TableCell className="py-3 text-center" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={!!c.otwDocsReceived} onCheckedChange={(v) => toggleDoc(c.id, !!v)}
                        data-testid={"checkbox-docs-" + c.id} aria-label={"Docs received for " + (c.containerNumber || "container")} />
                    </TableCell>
                    <TableCell className="py-3" onClick={(e) => e.stopPropagation()}>
                      <NotesCell containerId={c.id} note={c.otwNote ?? ""} onSave={saveNote} />
                    </TableCell>
                    <TableCell className="py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" title="Copy container number"
                          aria-label={"Copy number " + (c.containerNumber || "")} data-testid={"button-otw-copy-" + c.id}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(c.containerNumber || "");
                              toast({ title: "Container number copied" });
                            } catch {
                              toast({ title: "Could not copy container number", variant: "destructive" });
                            }
                          }}>
                          <Copy className="h-4 w-4" />
                        </Button>
                        {onEdit && <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg" title="Edit container"
                          aria-label={"Edit " + (c.containerNumber || "container")} onClick={() => onEdit(c)}
                          data-testid={"button-otw-edit-" + c.id}><Pencil className="h-4 w-4" /></Button>}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          <span>Showing {filtered.length} of {otwContainers.length} containers</span>
          <span className="hidden sm:inline">Click an ETA or note to edit</span>
        </div>
      </section>
    </div>
  );
}
