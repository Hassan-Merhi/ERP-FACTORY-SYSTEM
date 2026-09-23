import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import {
  ArrowLeftRight,
  BarChart3,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GitCompare,
  RefreshCw,
  Search,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PeriodFilter, getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { formatNumber } from "@/lib/formatNumber";

interface LocationOption {
  id: number;
  name: string;
}

interface StockGroupOption {
  id: number;
  name: string;
}

type GroupingType = "daily" | "monthly" | "yearly";

type MetricKey =
  | "stockInQty"
  | "stockInValue"
  | "stockInAvgRate"
  | "stockOutQty"
  | "totalSales"
  | "costOfSales"
  | "costProfit"
  | "avgProfitPerBale";

interface Metrics {
  stockInQty: number;
  stockInValue: number;
  stockInAvgRate: number;
  stockOutQty: number;
  totalSales: number;
  costOfSales: number;
  costProfit: number;
  avgProfitPerBale: number;
}

interface ComparisonSet {
  sideA: Metrics;
  sideB: Metrics;
  difference: Metrics;
}

interface ComparisonRow extends ComparisonSet {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
}

interface ItemComparisonRow extends ComparisonSet {
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  stockGroupId: number | null;
  stockGroupName: string;
}

interface ComparisonResponse {
  generatedAt: string;
  summary: ComparisonSet;
  rows: ComparisonRow[];
  rowCount: number;
  itemRows: ItemComparisonRow[];
  itemRowCount: number;
}

const EMPTY_METRICS: Metrics = {
  stockInQty: 0,
  stockInValue: 0,
  stockInAvgRate: 0,
  stockOutQty: 0,
  totalSales: 0,
  costOfSales: 0,
  costProfit: 0,
  avgProfitPerBale: 0,
};

const METRICS: Array<{ key: MetricKey; label: string; kind: "qty" | "money" | "rate" }> = [
  { key: "stockInQty", label: "Stock In Qty", kind: "qty" },
  { key: "stockInValue", label: "Stock In Value", kind: "money" },
  { key: "stockInAvgRate", label: "Average In Rate", kind: "rate" },
  { key: "stockOutQty", label: "Stock Out Qty", kind: "qty" },
  { key: "totalSales", label: "Total Sales", kind: "money" },
  { key: "costOfSales", label: "Cost of Sales", kind: "money" },
  { key: "costProfit", label: "Cost Profit", kind: "money" },
  { key: "avgProfitPerBale", label: "Average Profit / Bale", kind: "rate" },
];

const ITEM_PAGE_SIZE = 50;

function initialParams() {
  return new URLSearchParams(window.location.search);
}

function initialPeriodValue(params: URLSearchParams): PeriodFilterValue {
  const fromDate = params.get("startDate") || "";
  const toDate = params.get("endDate") || "";
  if (fromDate || toDate) return { fromDate, toDate, preset: "custom" };
  return getDefaultPeriodValue("all_time");
}

function GroupMultiSelect({
  groups,
  selectedIds,
  onChange,
  side,
}: {
  groups: StockGroupOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  side: "a" | "b";
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between" data-testid={`button-comparison-groups-${side}`}>
          {selectedIds.length === 0
            ? "All stock groups"
            : `${selectedIds.length} group${selectedIds.length === 1 ? "" : "s"}`}
          <ChevronDown className="h-4 w-4 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="max-h-72 space-y-1 overflow-y-auto">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted"
            onClick={() => onChange([])}
          >
            <Checkbox checked={selectedIds.length === 0} className="pointer-events-none" />
            <span className="font-medium">All stock groups</span>
          </button>
          <div className="border-t" />
          {groups.map((group) => {
            const id = String(group.id);
            const checked = selectedIds.includes(id);
            return (
              <button
                type="button"
                key={group.id}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted"
                onClick={() => onChange(checked ? selectedIds.filter((value) => value !== id) : [...selectedIds, id])}
              >
                <Checkbox checked={checked} className="pointer-events-none" />
                <span>{group.name}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SidePanel({
  title,
  locationId,
  onLocationChange,
  groupIds,
  onGroupsChange,
  locations,
  groups,
  side,
}: {
  title: string;
  locationId: string;
  onLocationChange: (value: string) => void;
  groupIds: string[];
  onGroupsChange: (ids: string[]) => void;
  locations: LocationOption[];
  groups: StockGroupOption[];
  side: "a" | "b";
}) {
  return (
    <div className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
          {side.toUpperCase()}
        </div>
        <div>
          <p className="font-semibold">{title}</p>
          <p className="text-xs text-muted-foreground">One location and any number of stock groups</p>
        </div>
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Location</label>
        <Select value={locationId} onValueChange={onLocationChange}>
          <SelectTrigger data-testid={`select-comparison-location-${side}`}>
            <SelectValue placeholder="Choose a location" />
          </SelectTrigger>
          <SelectContent>
            {locations.map((location) => (
              <SelectItem key={location.id} value={String(location.id)}>
                {location.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Stock groups</label>
        <GroupMultiSelect groups={groups} selectedIds={groupIds} onChange={onGroupsChange} side={side} />
      </div>
    </div>
  );
}

export default function StockInSalesReportComparison() {
  const params = useMemo(initialParams, []);
  const { selectedCompany } = useCompany();
  const { formatAmount, selectedCurrency, convertToDisplay } = useCurrencyContext();
  const { formatDisplayDate } = useDateFormat();

  const [period, setPeriod] = useState<PeriodFilterValue>(() => initialPeriodValue(params));
  const [grouping, setGrouping] = useState<GroupingType>(() => {
    const value = params.get("grouping");
    return value === "daily" || value === "monthly" || value === "yearly" ? value : "yearly";
  });
  const [search, setSearch] = useState(() => params.get("search") || "");
  const [sideALocationId, setSideALocationId] = useState(() => params.get("sideALocationId") || "");
  const [sideBLocationId, setSideBLocationId] = useState(() => params.get("sideBLocationId") || "");
  const [sideAGroupIds, setSideAGroupIds] = useState<string[]>(() =>
    (params.get("sideAStockGroupIds") || "").split(",").filter(Boolean)
  );
  const [sideBGroupIds, setSideBGroupIds] = useState<string[]>(() =>
    (params.get("sideBStockGroupIds") || "").split(",").filter(Boolean)
  );
  const [itemMetric, setItemMetric] = useState<MetricKey>("costProfit");
  const [itemPage, setItemPage] = useState(1);

  const { data: locations = [] } = useQuery<LocationOption[]>({
    queryKey: ["/api/locations", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
    staleTime: 5 * 60 * 1000,
  });
  const { data: stockGroups = [] } = useQuery<StockGroupOption[]>({
    queryKey: ["/api/stock-groups", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
    staleTime: 5 * 60 * 1000,
  });

  const sortedLocations = useMemo(() => [...locations].sort((a, b) => a.name.localeCompare(b.name)), [locations]);
  const sortedGroups = useMemo(() => [...stockGroups].sort((a, b) => a.name.localeCompare(b.name)), [stockGroups]);

  const sideALabel = sortedLocations.find((location) => String(location.id) === sideALocationId)?.name || "Side A";
  const sideBLabel = sortedLocations.find((location) => String(location.id) === sideBLocationId)?.name || "Side B";

  const queryUrl = useMemo(() => {
    if (!sideALocationId || !sideBLocationId) return "";
    const query = new URLSearchParams({
      grouping,
      sideALocationId,
      sideBLocationId,
    });
    if (period.fromDate) query.set("startDate", period.fromDate);
    if (period.toDate) query.set("endDate", period.toDate);
    if (sideAGroupIds.length > 0) query.set("sideAStockGroupIds", sideAGroupIds.join(","));
    if (sideBGroupIds.length > 0) query.set("sideBStockGroupIds", sideBGroupIds.join(","));
    if (search.trim()) query.set("search", search.trim());
    return `/api/reports/stock-in-sales/comparison?${query.toString()}`;
  }, [period, grouping, search, sideALocationId, sideBLocationId, sideAGroupIds, sideBGroupIds]);

  useEffect(() => setItemPage(1), [queryUrl, itemMetric]);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<ComparisonResponse, Error>({
    queryKey: [queryUrl, selectedCompany?.id],
    enabled: !!selectedCompany?.id && !!queryUrl,
    staleTime: 30_000,
  });

  const summary = data?.summary ?? {
    sideA: EMPTY_METRICS,
    sideB: EMPTY_METRICS,
    difference: EMPTY_METRICS,
  };

  const selectedItemMetric = METRICS.find((metric) => metric.key === itemMetric) ?? METRICS[0];
  const itemTotalPages = Math.max(1, Math.ceil((data?.itemRows.length || 0) / ITEM_PAGE_SIZE));
  const pagedItemRows = (data?.itemRows || []).slice((itemPage - 1) * ITEM_PAGE_SIZE, itemPage * ITEM_PAGE_SIZE);

  const formatMetric = (key: MetricKey, kind: "qty" | "money" | "rate", value: number): string => {
    if (kind === "qty") return formatNumber(value, 3);
    if (kind === "money") return value < 0 ? `-${formatAmount(Math.abs(value))}` : formatAmount(value);
    if (selectedCurrency === "CFA") {
      const converted = convertToDisplay(value);
      return `${value < 0 ? "-" : ""}CFA ${formatNumber(Math.abs(converted), 2)}`;
    }
    return `${value < 0 ? "-" : ""}$ ${formatNumber(Math.abs(value), key === "avgProfitPerBale" ? 2 : 6)}`;
  };

  const differenceClass = (value: number) =>
    value > 0
      ? "text-emerald-600 dark:text-emerald-400"
      : value < 0
        ? "text-red-600 dark:text-red-400"
        : "text-muted-foreground";

  const formatPeriod = (row: ComparisonRow) => {
    if (grouping === "yearly") return row.periodKey;
    if (grouping === "monthly") {
      try {
        return format(parseISO(`${row.periodKey}-01`), "MMMM yyyy");
      } catch {
        return row.periodKey;
      }
    }
    try {
      return formatDisplayDate(parseISO(row.periodKey));
    } catch {
      return row.periodKey;
    }
  };

  const swapSides = () => {
    const oldLocationA = sideALocationId;
    const oldGroupsA = sideAGroupIds;
    setSideALocationId(sideBLocationId);
    setSideAGroupIds(sideBGroupIds);
    setSideBLocationId(oldLocationA);
    setSideBGroupIds(oldGroupsA);
  };

  const clearComparison = () => {
    setPeriod(getDefaultPeriodValue("all_time"));
    setGrouping("yearly");
    setSearch("");
    setSideALocationId("");
    setSideBLocationId("");
    setSideAGroupIds([]);
    setSideBGroupIds([]);
    setItemMetric("costProfit");
  };

  const renderValue = (
    key: MetricKey,
    kind: "qty" | "money" | "rate",
    value: number,
    difference = false
  ): ReactNode => (
    <span className={`font-mono text-sm ${difference ? differenceClass(value) : ""}`}>
      {difference && value > 0 ? "+" : ""}
      {formatMetric(key, kind, value)}
    </span>
  );

  return (
    <div className="container mx-auto space-y-6 p-0 sm:p-6">
      <PageHeader
        title="Stock In & Sales Comparison"
        subtitle="Compare one location and stock-group selection against another"
        onBack={() => window.history.back()}
        meta={<span>Difference is Side A minus Side B{selectedCompany?.name ? ` · ${selectedCompany.name}` : ""}</span>}
      >
        <Button variant="outline" size="sm" onClick={clearComparison}>
          Clear
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
        <PeriodFilter value={period} onChange={setPeriod} data-testid="period-filter-stock-in-sales-comparison" />
        <Select value={grouping} onValueChange={(value) => setGrouping(value as GroupingType)}>
          <SelectTrigger className="w-32" data-testid="select-stock-in-sales-comparison-grouping">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="monthly">Monthly</SelectItem>
            <SelectItem value="yearly">Yearly</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative min-w-52 flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search item, group, location..."
            className="pl-9"
          />
        </div>
        {isFetching && !isLoading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto_1fr] lg:items-center">
        <SidePanel
          title="Side A"
          locationId={sideALocationId}
          onLocationChange={setSideALocationId}
          groupIds={sideAGroupIds}
          onGroupsChange={setSideAGroupIds}
          locations={sortedLocations}
          groups={sortedGroups}
          side="a"
        />
        <Button
          variant="outline"
          size="icon"
          onClick={swapSides}
          disabled={!sideALocationId && !sideBLocationId}
          title="Swap sides"
        >
          <ArrowLeftRight className="h-4 w-4" />
        </Button>
        <SidePanel
          title="Side B"
          locationId={sideBLocationId}
          onLocationChange={setSideBLocationId}
          groupIds={sideBGroupIds}
          onGroupsChange={setSideBGroupIds}
          locations={sortedLocations}
          groups={sortedGroups}
          side="b"
        />
      </div>

      {!sideALocationId || !sideBLocationId ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-14 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <GitCompare className="h-6 w-6 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium">Choose both comparison locations</p>
            <p className="mt-1 text-sm text-muted-foreground">
              You may use the same location on both sides to compare different stock groups.
            </p>
          </div>
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border py-12 text-center">
          <BarChart3 className="h-8 w-8 text-destructive" />
          <div>
            <p className="font-medium">Unable to load the comparison</p>
            <p className="mt-1 text-sm text-muted-foreground">{error?.message || "The comparison request failed."}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" /> Retry
          </Button>
        </div>
      ) : (
        <>
          <section className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold">Overall comparison</h2>
              <p className="text-xs text-muted-foreground">
                All metrics use the same date range and active search filter.
              </p>
            </div>
            <div className="overflow-hidden rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead>Metric</TableHead>
                    <TableHead className="text-right">{sideALabel}</TableHead>
                    <TableHead className="text-right">{sideBLabel}</TableHead>
                    <TableHead className="text-right">Difference (A − B)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading
                    ? METRICS.map((metric) => (
                        <TableRow key={metric.key}>
                          <TableCell>{metric.label}</TableCell>
                          {[0, 1, 2].map((cell) => (
                            <TableCell key={cell}>
                              <Skeleton className="ml-auto h-4 w-24" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    : METRICS.map((metric) => (
                        <TableRow key={metric.key}>
                          <TableCell className="font-medium">{metric.label}</TableCell>
                          <TableCell className="text-right">
                            {renderValue(metric.key, metric.kind, summary.sideA[metric.key])}
                          </TableCell>
                          <TableCell className="text-right">
                            {renderValue(metric.key, metric.kind, summary.sideB[metric.key])}
                          </TableCell>
                          <TableCell className="text-right font-semibold">
                            {renderValue(metric.key, metric.kind, summary.difference[metric.key], true)}
                          </TableCell>
                        </TableRow>
                      ))}
                </TableBody>
              </Table>
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">Period comparison</h2>
                <p className="text-xs text-muted-foreground">
                  Each period shows Side A, Side B, and the difference for every report metric.
                </p>
              </div>
              {data && (
                <p className="text-xs text-muted-foreground">
                  {data.rowCount} period{data.rowCount === 1 ? "" : "s"}
                </p>
              )}
            </div>
            <div className="overflow-hidden rounded-xl border">
              <div className="overflow-x-auto">
                <Table className="min-w-[850px]">
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead>Period</TableHead>
                      <TableHead>Metric</TableHead>
                      <TableHead className="text-right">{sideALabel}</TableHead>
                      <TableHead className="text-right">{sideBLabel}</TableHead>
                      <TableHead className="text-right">Difference (A − B)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      Array.from({ length: 8 }).map((_, index) => (
                        <TableRow key={index}>
                          {Array.from({ length: 5 }).map((__, cell) => (
                            <TableCell key={cell}>
                              <Skeleton className="h-4 w-full max-w-28" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : !data || data.rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-12 text-center text-sm text-muted-foreground">
                          No activity was found for either side with the selected filters.
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.rows.flatMap((row) =>
                        METRICS.map((metric, metricIndex) => (
                          <TableRow key={`${row.periodKey}-${metric.key}`}>
                            {metricIndex === 0 && (
                              <TableCell rowSpan={METRICS.length} className="align-top font-semibold">
                                {formatPeriod(row)}
                              </TableCell>
                            )}
                            <TableCell className="font-medium text-muted-foreground">{metric.label}</TableCell>
                            <TableCell className="text-right">
                              {renderValue(metric.key, metric.kind, row.sideA[metric.key])}
                            </TableCell>
                            <TableCell className="text-right">
                              {renderValue(metric.key, metric.kind, row.sideB[metric.key])}
                            </TableCell>
                            <TableCell className="text-right font-semibold">
                              {renderValue(metric.key, metric.kind, row.difference[metric.key], true)}
                            </TableCell>
                          </TableRow>
                        ))
                      )
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Item comparison</h2>
                <p className="text-xs text-muted-foreground">
                  Choose any report metric to compare every matching stock item across the two sides.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select value={itemMetric} onValueChange={(value) => setItemMetric(value as MetricKey)}>
                  <SelectTrigger className="w-52" data-testid="select-item-comparison-metric">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {METRICS.map((metric) => (
                      <SelectItem key={metric.key} value={metric.key}>
                        {metric.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {data && (
                  <span className="text-xs text-muted-foreground">
                    {data.itemRowCount} item{data.itemRowCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            </div>
            <div className="overflow-hidden rounded-xl border">
              <div className="overflow-x-auto">
                <Table className="min-w-[820px]">
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead>Item</TableHead>
                      <TableHead>Stock Group</TableHead>
                      <TableHead className="text-right">{sideALabel}</TableHead>
                      <TableHead className="text-right">{sideBLabel}</TableHead>
                      <TableHead className="text-right">Difference (A − B)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      Array.from({ length: 8 }).map((_, index) => (
                        <TableRow key={index}>
                          {Array.from({ length: 5 }).map((__, cell) => (
                            <TableCell key={cell}>
                              <Skeleton className="h-4 w-full max-w-28" />
                            </TableCell>
                          ))}
                        </TableRow>
                      ))
                    ) : pagedItemRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                          No matching stock items found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      pagedItemRows.map((row) => (
                        <TableRow key={row.stockItemId}>
                          <TableCell>
                            <div className="font-medium">{row.stockItemName}</div>
                            <div className="text-xs text-muted-foreground">{row.stockItemCode}</div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{row.stockGroupName}</TableCell>
                          <TableCell className="text-right">
                            {renderValue(itemMetric, selectedItemMetric.kind, row.sideA[itemMetric])}
                          </TableCell>
                          <TableCell className="text-right">
                            {renderValue(itemMetric, selectedItemMetric.kind, row.sideB[itemMetric])}
                          </TableCell>
                          <TableCell className="text-right font-semibold">
                            {renderValue(itemMetric, selectedItemMetric.kind, row.difference[itemMetric], true)}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              {data && data.itemRowCount > ITEM_PAGE_SIZE && (
                <div className="flex items-center justify-between border-t px-4 py-3">
                  <p className="text-xs text-muted-foreground">
                    Page {itemPage} of {itemTotalPages}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setItemPage((page) => Math.max(1, page - 1))}
                      disabled={itemPage <= 1}
                    >
                      <ChevronLeft className="mr-1 h-4 w-4" /> Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setItemPage((page) => Math.min(itemTotalPages, page + 1))}
                      disabled={itemPage >= itemTotalPages}
                    >
                      Next <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </>
      )}

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="h-3.5 w-3.5" />
        <span>Direct container offloads only; sales use stored historical cost and credit/debit notes are netted.</span>
      </div>
    </div>
  );
}
