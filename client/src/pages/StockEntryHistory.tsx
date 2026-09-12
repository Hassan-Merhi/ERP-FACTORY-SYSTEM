import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient, useQueries } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Search,
  RotateCcw,
  List,
  AlignJustify,
  FileDown,
  MoreVertical,
  CalendarRange,
  MessageCircle,
  Loader2,
  History,
  Users,
  Package,
  MapPin,
  Tag,
  Layers,
} from "lucide-react";
import ProductionPlannerDialog from "./factory/ProductionPlannerDialog";
import { MultiSelectFilter } from "./factory/productioncomparison/components/MultiSelectFilter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import type { Location } from "@shared/schema";

import type { BaleDetail, GroupRow, StockEntryHistoryPage, StockEntryHistoryProps } from "./stockentryhistory/types";
import type { StockEntryWorker, WorkerCategory } from "./stockentryhistory/derived";
import { deriveStockEntryHistory } from "./stockentryhistory/derived";
import { createStockEntryHistoryGroupBaleHelpers, groupKey } from "./stockentryhistory/groupBaleHelpers";
import { createStockEntryHistoryReports } from "./stockentryhistory/reports";
import { StockEntryHistoryEditableDateCell } from "./stockentryhistory/EditableDateCell";
import { DetailedHistoryTable } from "./stockentryhistory/DetailedHistoryTable";
import { useStockEntryHistoryMutations } from "./stockentryhistory/useStockEntryHistoryMutations";
import { STATUS_COLORS, STATUS_OPTIONS, fetchAllStockEntryHistoryPages } from "./stockentryhistory/utils";

export default function StockEntryHistory({ onActiveDateChange }: StockEntryHistoryProps = {}) {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const qc = useQueryClient();
  const today = new Date().toLocaleDateString("en-CA");
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toLocaleDateString("en-CA");

  const [fromActive, setFromActive] = useState(true);
  const [toActive, setToActive] = useState(true);
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);

  useEffect(() => {
    if (!onActiveDateChange) return;
    onActiveDateChange(fromActive ? fromDate : null);
  }, [fromActive, fromDate, onActiveDateChange]);

  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [productCategoryFilter, setProductCategoryFilter] = useState<string[]>([]);
  const [workerIdFilter, setWorkerIdFilter] = useState<string[]>([]);
  const [productIdFilter, setProductIdFilter] = useState<string[]>([]);
  const [locationIdFilter, setLocationIdFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);
  const [includeUnassigned, setIncludeUnassigned] = useState(true);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<"condensed" | "detailed">("condensed");
  const [editingDateKey, setEditingDateKey] = useState<string | null>(null);

  const useLite = viewMode === "condensed";
  const page = 1;
  const pageSize = 9999;

  const filtersKey = useMemo(
    () =>
      [
        fromActive ? fromDate : "",
        toActive ? toDate : "",
        workerIdFilter.join(","),
        productIdFilter.join(","),
        locationIdFilter.join(","),
        categoryFilter.join(","),
        productCategoryFilter.join(","),
        statusFilter.join(","),
        debouncedSearch,
        String(includeUnassigned),
        String(useLite),
      ].join("|"),
    [
      fromActive,
      fromDate,
      toActive,
      toDate,
      workerIdFilter,
      productIdFilter,
      locationIdFilter,
      categoryFilter,
      productCategoryFilter,
      statusFilter,
      debouncedSearch,
      includeUnassigned,
      useLite,
    ]
  );
  void filtersKey;

  const params = new URLSearchParams();
  if (fromActive) params.set("startDate", fromDate);
  if (toActive) params.set("endDate", toDate);
  if (workerIdFilter.length > 0) params.set("workerId", workerIdFilter.join(","));
  if (productIdFilter.length > 0) params.set("productId", productIdFilter.join(","));
  if (locationIdFilter.length > 0) params.set("locationId", locationIdFilter.join(","));
  if (categoryFilter.length > 0) params.set("workerCategoryId", categoryFilter.join(","));
  if (productCategoryFilter.length > 0) params.set("categoryId", productCategoryFilter.join(","));
  if (statusFilter.length > 0) params.set("status", statusFilter.join(","));
  if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
  if (!includeUnassigned) params.set("includeUnassigned", "false");
  if (useLite) params.set("lite", "1");
  params.set("page", String(page));
  params.set("limit", String(pageSize));

  const { data: pagedGroups, isLoading } = useQuery<StockEntryHistoryPage>({
    queryKey: ["/api/factory/bales/stock-entry-history", params.toString(), page, pageSize],
    queryFn: async () => {
      const r = await fetch(`/api/factory/bales/stock-entry-history?${params.toString()}`, { credentials: "include" });
      if (!r.ok) throw new Error(`Stock entry history failed: ${r.status}`);
      const data = await r.json();
      if (!Array.isArray(data.items)) throw new Error("Invalid response: items is not an array");
      return data as StockEntryHistoryPage;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: (prev) => prev,
  });
  const groups: GroupRow[] = useMemo(() => pagedGroups?.items ?? [], [pagedGroups]);

  const { data: workers = [] } = useQuery<StockEntryWorker[]>({
    queryKey: ["/api/factory/workers"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const { data: products = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/factory/bale-products"],
  });
  const { data: locations = [] } = useQuery<Location[]>({ queryKey: ["/api/locations"] });
  const { data: categories = [] } = useQuery<(WorkerCategory & { name: string })[]>({
    queryKey: ["/api/factory/worker-categories"],
    queryFn: () => fetch("/api/factory/worker-categories", { credentials: "include" }).then((r) => r.json()),
  });
  const { data: productCategories = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/factory/categories"],
    queryFn: () => fetch("/api/factory/categories", { credentials: "include" }).then((r) => r.json()),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const planDate = fromActive && toActive && fromDate === toDate ? fromDate : null;
  const { data: workerTargets = {} } = useQuery<Record<number, { targetBales: number; workerCount: number }>>({
    queryKey: ["/api/factory/production-planner", planDate, "worker-targets"],
    queryFn: () =>
      fetch(`/api/factory/production-planner/${planDate}/worker-targets`, { credentials: "include" }).then((r) =>
        r.json()
      ),
    enabled: !!planDate,
  });

  const expandedGroupBaleKeys = useMemo(
    () => Array.from(expandedKeys).filter((k) => k.endsWith("-bales")),
    [expandedKeys]
  );
  const groupBaleQueries = useQueries({
    queries: expandedGroupBaleKeys.map((key) => {
      const baseKey = key.replace(/-bales$/, "");
      const group = groups.find((g) => groupKey(g) === baseKey);
      if (!group) return { queryKey: ["noop", key], queryFn: () => [] as BaleDetail[], enabled: false };
      const gp = new URLSearchParams();
      gp.set("startDate", group.stockEntryDate);
      gp.set("endDate", group.stockEntryDate);
      if (group.workerId) gp.set("workerId", String(group.workerId));
      if (group.productId) gp.set("productId", String(group.productId));
      if (group.erpLocationId) gp.set("locationId", String(group.erpLocationId));
      return {
        queryKey: ["/api/factory/bales/stock-entry-history/group", gp.toString()],
        queryFn: (): Promise<BaleDetail[]> =>
          fetchAllStockEntryHistoryPages(gp).then((rows) => rows.flatMap((g) => g.bales ?? [])),
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        enabled: useLite && !!group,
      };
    }),
  });

  const { filteredWorkers, filteredGroups, totalBales, totalWeight, workerGroups, allBales } = useMemo(
    () =>
      deriveStockEntryHistory({
        groups,
        workers,
        categories,
        categoryFilter,
        workerIdFilter,
        workerTargets,
      }),
    [groups, workers, categories, categoryFilter, workerIdFilter, workerTargets]
  );

  const { updateDateMutation, bulkAssignMutation, sendWorkerPdfWaMutation } = useStockEntryHistoryMutations({
    fromActive,
    fromDate,
    today,
    setEditingDateKey,
  });

  const { getGroupBales, resolveGroupBaleIds, isGroupBalesLoading, fetchGroupsWithBales } =
    createStockEntryHistoryGroupBaleHelpers({
      useLite,
      expandedGroupBaleKeys,
      groupBaleQueries,
      queryClient: qc,
      params,
    });

  function toggleExpand(key: string) {
    setExpandedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function resetFilters() {
    setFromActive(false);
    setToActive(false);
    setFromDate(today);
    setToDate(today);
    setCategoryFilter([]);
    setProductCategoryFilter([]);
    setWorkerIdFilter([]);
    setProductIdFilter([]);
    setLocationIdFilter([]);
    setStatusFilter([]);
    setSearch("");
    setIncludeUnassigned(true);
  }

  const { exportExcel, handlePrintMatrix, handleExportWorkerPDF } = createStockEntryHistoryReports({
    filteredGroups,
    fetchGroupsWithBales,
    fromDate,
    toDate,
  });
  void handlePrintMatrix;
  void thirtyDaysAgo;

  function EditableDateCell({
    dateStr,
    editKey,
    onSave,
  }: {
    dateStr: string;
    editKey: string;
    onSave: (newDate: string) => void;
  }) {
    return (
      <StockEntryHistoryEditableDateCell
        dateStr={dateStr}
        editKey={editKey}
        onSave={onSave}
        editingDateKey={editingDateKey}
        setEditingDateKey={setEditingDateKey}
        formatDisplayDate={formatDisplayDate}
      />
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center h-8 w-8 rounded-xl bg-gradient-to-br from-sky-500/30 to-sky-600/10 border border-sky-500/25 shrink-0">
            <History className="h-4 w-4 text-sky-500" />
          </div>
          <div>
            <h2 className="text-base font-bold leading-tight">Stock Entry History</h2>
            <p className="text-xs text-muted-foreground leading-tight">Browse and filter recorded bale entries</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ProductionPlannerDialog />
          <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
            <Button
              variant={viewMode === "condensed" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs rounded-md"
              onClick={() => setViewMode("condensed")}
              data-testid="button-view-condensed"
            >
              <AlignJustify className="w-3 h-3 mr-1" /> Condensed
            </Button>
            <Button
              variant={viewMode === "detailed" ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs rounded-md"
              onClick={() => setViewMode("detailed")}
              data-testid="button-view-detailed"
            >
              <List className="w-3 h-3 mr-1" /> Detailed
            </Button>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" data-testid="button-actions-menu">
                <MoreVertical className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={resetFilters} data-testid="button-reset-filters">
                <RotateCcw className="w-3 h-3 mr-2" /> Reset Filters
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleExportWorkerPDF}
                disabled={filteredGroups.length === 0}
                data-testid="button-export-worker-pdf"
              >
                <FileDown className="w-3 h-3 mr-2" /> Worker PDF
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => sendWorkerPdfWaMutation.mutate()}
                disabled={filteredGroups.length === 0 || sendWorkerPdfWaMutation.isPending}
                data-testid="button-send-worker-pdf-whatsapp"
              >
                {sendWorkerPdfWaMutation.isPending ? (
                  <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                ) : (
                  <MessageCircle className="w-3 h-3 mr-2" />
                )}
                Send Worker PDF to WhatsApp
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={exportExcel}
                disabled={filteredGroups.length === 0}
                data-testid="button-export-excel"
              >
                <Download className="w-3 h-3 mr-2" /> Export Excel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="rounded-xl border bg-muted/30 p-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium">
              <Layers className="h-3 w-3" />
              Bale Category
            </div>
            <MultiSelectFilter
              options={productCategories.map((c) => ({ value: String(c.id), label: c.name }))}
              selected={productCategoryFilter}
              onChange={setProductCategoryFilter}
              placeholder="Bale categories"
              allLabel="All Categories"
              className="h-8 w-full min-w-0 px-2 py-0 text-xs"
              testId="select-product-category"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium">
              <Users className="h-3 w-3" />
              Worker Group
            </div>
            <MultiSelectFilter
              options={categories.map((c) => ({ value: String(c.id), label: c.name }))}
              selected={categoryFilter}
              onChange={(next) => {
                setCategoryFilter(next);
                if (next.length === 0) return;
                const selectedGroups = new Set(next);
                const allowedWorkerIds = new Set<number>();
                for (const category of categories) {
                  if (!selectedGroups.has(String(category.id))) continue;
                  for (const workerId of Array.isArray(category.workerIds) ? category.workerIds : []) {
                    allowedWorkerIds.add(Number(workerId));
                  }
                }
                setWorkerIdFilter((prev) => prev.filter((id) => allowedWorkerIds.has(Number(id))));
              }}
              placeholder="Worker groups"
              allLabel="All Groups"
              className="h-8 w-full min-w-0 px-2 py-0 text-xs"
              testId="select-category"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium">
              <Users className="h-3 w-3" />
              Worker
            </div>
            <MultiSelectFilter
              options={filteredWorkers.map((w) => ({
                value: String(w.id),
                label: w.fullName || w.full_name || w.name || String(w.id),
              }))}
              selected={workerIdFilter}
              onChange={setWorkerIdFilter}
              placeholder="Workers"
              allLabel="All Workers"
              className="h-8 w-full min-w-0 px-2 py-0 text-xs"
              testId="select-worker"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium">
              <Package className="h-3 w-3" />
              Product
            </div>
            <MultiSelectFilter
              options={products.map((p) => ({ value: String(p.id), label: p.name }))}
              selected={productIdFilter}
              onChange={setProductIdFilter}
              placeholder="Products"
              allLabel="All Products"
              className="h-8 w-full min-w-0 px-2 py-0 text-xs"
              testId="select-product"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium">
              <MapPin className="h-3 w-3" />
              Location
            </div>
            <MultiSelectFilter
              options={locations.map((l) => ({ value: String(l.id), label: l.name }))}
              selected={locationIdFilter}
              onChange={setLocationIdFilter}
              placeholder="Locations"
              allLabel="All Locations"
              className="h-8 w-full min-w-0 px-2 py-0 text-xs"
              testId="select-location"
            />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium">
              <Tag className="h-3 w-3" />
              Status
            </div>
            <MultiSelectFilter
              options={STATUS_OPTIONS}
              selected={statusFilter}
              onChange={setStatusFilter}
              placeholder="Statuses"
              allLabel="All Statuses"
              className="h-8 w-full min-w-0 px-2 py-0 text-xs"
              testId="select-status"
            />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 rounded-xl border bg-muted/30 flex-wrap">
        <Button
          variant={fromActive ? "default" : "ghost"}
          size="sm"
          onClick={() => setFromActive((v) => !v)}
          data-testid="button-toggle-from-date"
          className="toggle-elevate shrink-0 h-7 px-2.5 text-xs"
        >
          <CalendarRange className="w-3.5 h-3.5 mr-1.5" />
          From
        </Button>
        {fromActive && (
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            data-testid="input-from-date"
            className="w-34 h-7 text-xs shrink-0"
          />
        )}
        <Button
          variant={toActive ? "default" : "ghost"}
          size="sm"
          onClick={() => {
            setToActive((prev) => {
              const next = !prev;
              if (next) setFromActive(false);
              return next;
            });
          }}
          data-testid="button-toggle-to-date"
          className="toggle-elevate shrink-0 h-7 px-2.5 text-xs"
        >
          To
        </Button>
        {toActive && (
          <Input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            data-testid="input-to-date"
            className="w-34 h-7 text-xs shrink-0"
          />
        )}
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            className="pl-8 h-7 text-xs"
            placeholder="Search by reference number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search"
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Checkbox
            id="include-unassigned"
            checked={includeUnassigned}
            onCheckedChange={(v) => setIncludeUnassigned(!!v)}
            data-testid="checkbox-include-unassigned"
          />
          <Label htmlFor="include-unassigned" className="text-xs cursor-pointer whitespace-nowrap">
            Include Unassigned
          </Label>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-slate-500/10 border-slate-500/20">
          <span className="text-xs font-semibold text-slate-500">Groups</span>
          <span className="text-sm font-bold tabular-nums text-slate-600 dark:text-slate-300">
            {(pagedGroups?.total ?? filteredGroups.length).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-emerald-500/10 border-emerald-500/20">
          <span className="text-xs font-semibold text-emerald-500">Bales</span>
          <span className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {(pagedGroups?.totalBales ?? totalBales).toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-sky-500/10 border-sky-500/20">
          <span className="text-xs font-semibold text-sky-500">Weight</span>
          <span className="text-sm font-bold tabular-nums text-sky-600 dark:text-sky-400">
            {(pagedGroups?.totalWeight ?? totalWeight).toFixed(2)}
          </span>
          <span className="text-xs text-sky-600/70 dark:text-sky-400/70">kg</span>
        </div>
      </div>

      {viewMode === "condensed" && (
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-30 bg-muted border-b-2 border-border/60">
              <tr className="text-left">
                <th className="px-3 py-2.5 w-6"></th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  No. Workers
                </th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground tracking-wide">Worker</th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  Target
                </th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  Shortage
                </th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  Bales
                </th>
                <th className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground tracking-wide">
                  Total kg
                </th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && workerGroups.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    No stock entry records found for the selected filters.
                  </td>
                </tr>
              )}
              {workerGroups.map((wg) => {
                const wExpanded = expandedKeys.has(wg.workerKey);
                const plan = wg.workerId != null ? workerTargets[wg.workerId] : undefined;
                const target = plan?.targetBales ?? 0;
                const workerCount = plan?.workerCount ?? 0;
                const diff = wg.totalBales - target;
                return [
                  <tr
                    key={wg.workerKey}
                    className="border-t hover-elevate cursor-pointer bg-muted/30"
                    onClick={() => toggleExpand(wg.workerKey)}
                    data-testid={`row-worker-${wg.workerKey}`}
                  >
                    <td className="px-3 py-2 text-muted-foreground">
                      {wExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {plan && workerCount > 0 ? workerCount : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 font-semibold">
                      {wg.workerName || <span className="italic text-muted-foreground">Unassigned</span>}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {plan && target > 0 ? target : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">
                      {plan && target > 0 ? (
                        <span
                          className={
                            diff >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                          }
                        >
                          {diff >= 0 ? `+${diff}` : diff}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold">{wg.totalBales}</td>
                    <td className="px-3 py-2 text-right font-semibold">{wg.totalWeight.toFixed(2)}</td>
                  </tr>,
                  wExpanded && (
                    <tr key={wg.workerKey + "-sub"} className="bg-muted/10">
                      <td colSpan={7} className="px-0 py-0">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-muted-foreground border-b bg-muted/20">
                              <th className="px-8 py-1.5 text-left w-6"></th>
                              <th className="px-3 py-1.5 text-left">Date</th>
                              <th className="px-3 py-1.5 text-left">Location</th>
                              <th className="px-3 py-1.5 text-left">Product</th>
                              <th className="px-3 py-1.5 text-right">Bales</th>
                              <th className="px-3 py-1.5 text-right">Total kg</th>
                              <th className="px-3 py-1.5 text-right">Avg kg</th>
                              <th className="px-3 py-1.5">Reassign</th>
                            </tr>
                          </thead>
                          <tbody>
                            {wg.groups.map((g) => {
                              const gKey = groupKey(g);
                              const gExpanded = expandedKeys.has(gKey + "-bales");
                              return [
                                <tr
                                  key={gKey}
                                  className="border-t border-border/40 hover-elevate cursor-pointer"
                                  onClick={() => toggleExpand(gKey + "-bales")}
                                  data-testid={`row-group-${gKey}`}
                                >
                                  <td className="px-8 py-1.5 text-muted-foreground">
                                    {gExpanded ? (
                                      <ChevronDown className="w-3 h-3" />
                                    ) : (
                                      <ChevronRight className="w-3 h-3" />
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                                    <EditableDateCell
                                      dateStr={g.stockEntryDate}
                                      editKey={`group-${groupKey(g)}`}
                                      onSave={async (newDate) => {
                                        const baleIds = await resolveGroupBaleIds(g);
                                        if (baleIds.length === 0) {
                                          toast({ title: "No bales found", variant: "destructive" });
                                          return;
                                        }
                                        updateDateMutation.mutate({ ids: baleIds, stockEntryDate: newDate });
                                      }}
                                    />
                                  </td>
                                  <td className="px-3 py-1.5">{g.locationName}</td>
                                  <td className="px-3 py-1.5">
                                    {g.productName || "—"}
                                    {g.articleCode && (
                                      <span className="ml-1 text-muted-foreground">({g.articleCode})</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-medium">{g.baleCount}</td>
                                  <td className="px-3 py-1.5 text-right">
                                    {parseFloat(g.totalWeight || "0").toFixed(2)}
                                  </td>
                                  <td className="px-3 py-1.5 text-right">
                                    {parseFloat(g.avgWeight || "0").toFixed(2)}
                                  </td>
                                  <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                                    <Select
                                      value={g.workerId ? String(g.workerId) : ""}
                                      onValueChange={async (v) => {
                                        const workerId = parseInt(v);
                                        const baleIds = await resolveGroupBaleIds(g);
                                        if (baleIds.length === 0) {
                                          toast({
                                            title: "Reassign failed",
                                            description: "Could not find any bales for this group.",
                                            variant: "destructive",
                                          });
                                          return;
                                        }
                                        bulkAssignMutation.mutate({ baleIds, workerId });
                                      }}
                                    >
                                      <SelectTrigger
                                        className="h-6 w-36 text-xs"
                                        data-testid={`select-assign-worker-${gKey}`}
                                      >
                                        <SelectValue placeholder="Reassign…" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {workers
                                          .filter((w) => w.active)
                                          .map((w) => (
                                            <SelectItem key={w.id} value={String(w.id)}>
                                              {w.fullName || w.full_name || w.name}
                                            </SelectItem>
                                          ))}
                                      </SelectContent>
                                    </Select>
                                  </td>
                                </tr>,
                                gExpanded && (
                                  <tr key={gKey + "-bales-detail"} className="bg-muted/20">
                                    <td colSpan={10} className="px-12 py-2">
                                      <table className="w-full text-xs">
                                        <thead>
                                          <tr className="text-muted-foreground">
                                            <th className="text-left pb-1 pr-4">Reference</th>
                                            <th className="text-right pb-1 pr-4">Weight (kg)</th>
                                            <th className="text-left pb-1 pr-4">Status</th>
                                            <th className="text-left pb-1">Finalized At</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {isGroupBalesLoading(g) ? (
                                            <tr>
                                              <td colSpan={4} className="py-2 text-xs text-muted-foreground">
                                                Loading bale details…
                                              </td>
                                            </tr>
                                          ) : (
                                            getGroupBales(g).map((b) => (
                                              <tr
                                                key={b.id}
                                                className="border-t border-border/30"
                                                data-testid={`row-bale-${b.id}`}
                                              >
                                                <td className="py-1 pr-4 font-mono">{b.referenceNumber}</td>
                                                <td className="py-1 pr-4 text-right">
                                                  {parseFloat(b.weightKg || "0").toFixed(2)}
                                                </td>
                                                <td className="py-1 pr-4">
                                                  <span
                                                    className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-semibold ${STATUS_COLORS[b.status] || "bg-muted text-muted-foreground"}`}
                                                  >
                                                    {b.status}
                                                  </span>
                                                </td>
                                                <td className="py-1">
                                                  {b.finalizedAt
                                                    ? new Date(b.finalizedAt).toLocaleTimeString([], {
                                                        hour: "2-digit",
                                                        minute: "2-digit",
                                                      })
                                                    : "—"}
                                                </td>
                                              </tr>
                                            ))
                                          )}
                                        </tbody>
                                      </table>
                                    </td>
                                  </tr>
                                ),
                              ];
                            })}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}

      {viewMode === "detailed" && (
        <DetailedHistoryTable
          isLoading={isLoading}
          allBales={allBales}
          editingDateKey={editingDateKey}
          setEditingDateKey={setEditingDateKey}
          formatDisplayDate={formatDisplayDate}
          onUpdateDate={(baleId, stockEntryDate) => updateDateMutation.mutate({ ids: [baleId], stockEntryDate })}
        />
      )}
    </div>
  );
}
