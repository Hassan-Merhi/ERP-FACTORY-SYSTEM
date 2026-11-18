// Extracted from ./StockInSalesReportComparison.tsx to keep that module under the source-size cap.
import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { formatNumber } from "@/lib/formatNumber";

export interface LocationOption {
  id: number;
  name: string;
}

export interface StockGroupOption {
  id: number;
  name: string;
}

export type GroupingType = "daily" | "monthly" | "yearly";

export type MetricKey =
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

export interface ComparisonRow extends ComparisonSet {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
}

export interface ItemComparisonRow extends ComparisonSet {
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

export const METRICS: Array<{ key: MetricKey; label: string; kind: "qty" | "money" | "rate" }> = [
  { key: "stockInQty", label: "Stock In Qty", kind: "qty" },
  { key: "stockInValue", label: "Stock In Value", kind: "money" },
  { key: "stockInAvgRate", label: "Average In Rate", kind: "rate" },
  { key: "stockOutQty", label: "Stock Out Qty", kind: "qty" },
  { key: "totalSales", label: "Total Sales", kind: "money" },
  { key: "costOfSales", label: "Cost of Sales", kind: "money" },
  { key: "costProfit", label: "Cost Profit", kind: "money" },
  { key: "avgProfitPerBale", label: "Average Profit / Bale", kind: "rate" },
];

export const ITEM_PAGE_SIZE = 50;

function initialParams() {
  return new URLSearchParams(window.location.search);
}

function initialPeriodValue(params: URLSearchParams): PeriodFilterValue {
  const fromDate = params.get("startDate") || "";
  const toDate = params.get("endDate") || "";
  if (fromDate || toDate) return { fromDate, toDate, preset: "custom" };
  return getDefaultPeriodValue("all_time");
}

export function useStockInSalesReportComparisonState() {
  const params = useMemo(initialParams, []);
  const { selectedCompany } = useCompany();
  const { formatAmount, selectedCurrency, convertToDisplay, displayCurrency } = useCurrencyContext();
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
    if (displayCurrency && selectedCurrency === displayCurrency) {
      const converted = convertToDisplay(value);
      if (Number.isFinite(converted)) {
        const label =
          displayCurrency === "CFA"
            ? `CFA ${formatNumber(Math.abs(converted), 2)}`
            : formatMoneyDisplay(Math.abs(converted), { currency: displayCurrency });
        return `${value < 0 ? "-" : ""}${label}`;
      }
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
  return {
    clearComparison,
    data,
    error,
    formatMetric,
    formatPeriod,
    grouping,
    isError,
    isFetching,
    isLoading,
    itemMetric,
    itemPage,
    itemTotalPages,
    pagedItemRows,
    period,
    refetch,
    renderValue,
    search,
    selectedCompany,
    selectedItemMetric,
    setGrouping,
    setItemMetric,
    setItemPage,
    setPeriod,
    setSearch,
    setSideAGroupIds,
    setSideALocationId,
    setSideBGroupIds,
    setSideBLocationId,
    sideAGroupIds,
    sideALabel,
    sideALocationId,
    sideBGroupIds,
    sideBLabel,
    sideBLocationId,
    sortedGroups,
    sortedLocations,
    summary,
    swapSides,
  };
}
