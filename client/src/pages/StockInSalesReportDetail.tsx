import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { PackageMinus, PackagePlus, RefreshCw, TrendingDown } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { ErpReportExportMenu, ErpReportPrintFooter } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { formatNumber } from "@/lib/formatNumber";

interface Metrics {
  openingStockQty: number;
  openingStockValue: number;
  stockInQty: number;
  stockInValue: number;
  stockInAvgRate: number;
  stockAdjustmentQty: number;
  stockAdjustmentValue: number;
  totalAvailableQty: number;
  stockOutQty: number;
  stockOutValue: number;
  closingStockQty: number;
  closingStockValue: number;
  totalSales: number;
  costOfSales: number;
  costProfit: number;
  avgProfitPerBale: number;
}

interface StockInRow {
  id: number;
  activityDate: string;
  containerNumber: string;
  locationName: string;
  stockItemId?: number;
  stockItemName: string;
  quantity: number;
  avgRate: number;
  totalValue: number;
}

interface StockOutRow {
  id: number;
  sourceType: "Sale" | "Credit Note" | "Debit Note";
  activityDate: string;
  isCreditSale: boolean | null;
  locationName: string;
  stockItemId?: number;
  stockItemName: string;
  quantity: number;
  sellingRate?: number;
  totalSales: number;
  totalCost: number;
  costProfit: number;
  avgProfitPerBale: number;
}

interface StockAdjustmentRow {
  id: number;
  activityDate: string;
  voucherId: number;
  voucherNumber: string;
  locationName: string;
  adjustmentType: string;
  direction: "In" | "Out";
  stockItemId?: number;
  stockItemName: string;
  quantity: number;
  unitRate: number;
  totalValue: number;
}

interface PagedRows<T> {
  rows: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  truncated: boolean;
}

interface DetailResponse {
  generatedAt: string;
  period: { startDate: string; endDate: string };
  summary: Metrics;
  stockIn: PagedRows<StockInRow>;
  stockOut: PagedRows<StockOutRow>;
  adjustments?: PagedRows<StockAdjustmentRow>;
}

interface GroupedStockInRow {
  key: string;
  stockItemName: string;
  quantity: number;
  avgRate: number;
  totalValue: number;
  dates: string[];
  containers: Array<{ name: string; quantity: number }>;
  locations: Array<{ name: string; quantity: number }>;
}

interface GroupedSalesRow {
  key: string;
  activityDate: string;
  stockItemName: string;
  quantity: number;
  avgRate: number;
  totalValue: number;
  profitPerBale: number;
  totalProfit: number;
  locations: Array<{ name: string; quantity: number }>;
}

const EMPTY_METRICS: Metrics = {
  openingStockQty: 0,
  openingStockValue: 0,
  stockInQty: 0,
  stockInValue: 0,
  stockInAvgRate: 0,
  stockAdjustmentQty: 0,
  stockAdjustmentValue: 0,
  totalAvailableQty: 0,
  stockOutQty: 0,
  stockOutValue: 0,
  closingStockQty: 0,
  closingStockValue: 0,
  totalSales: 0,
  costOfSales: 0,
  costProfit: 0,
  avgProfitPerBale: 0,
};

function sumMap(target: Map<string, number>, key: string, quantity: number): void {
  target.set(key || "Unassigned", (target.get(key || "Unassigned") || 0) + quantity);
}

function mapToBreakdown(map: Map<string, number>): Array<{ name: string; quantity: number }> {
  return [...map.entries()]
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

function groupStockInRows(rows: StockInRow[]): GroupedStockInRow[] {
  const groups = new Map<
    string,
    {
      stockItemName: string;
      quantity: number;
      totalValue: number;
      dates: Set<string>;
      containers: Map<string, number>;
      locations: Map<string, number>;
    }
  >();

  for (const row of rows) {
    const key = String(row.stockItemId ?? row.stockItemName);
    const group = groups.get(key) ?? {
      stockItemName: row.stockItemName,
      quantity: 0,
      totalValue: 0,
      dates: new Set<string>(),
      containers: new Map<string, number>(),
      locations: new Map<string, number>(),
    };
    group.quantity += Number(row.quantity || 0);
    group.totalValue += Number(row.totalValue || 0);
    group.dates.add(row.activityDate);
    sumMap(group.containers, row.containerNumber, Number(row.quantity || 0));
    sumMap(group.locations, row.locationName, Number(row.quantity || 0));
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      stockItemName: group.stockItemName,
      quantity: group.quantity,
      totalValue: group.totalValue,
      avgRate: group.quantity === 0 ? 0 : group.totalValue / group.quantity,
      dates: [...group.dates].sort((a, b) => b.localeCompare(a)),
      containers: mapToBreakdown(group.containers),
      locations: mapToBreakdown(group.locations),
    }))
    .sort((a, b) => a.stockItemName.localeCompare(b.stockItemName, undefined, { numeric: true, sensitivity: "base" }));
}

function groupSalesRows(rows: StockOutRow[]): GroupedSalesRow[] {
  const groups = new Map<
    string,
    {
      activityDate: string;
      stockItemName: string;
      quantity: number;
      totalValue: number;
      totalProfit: number;
      locations: Map<string, number>;
    }
  >();

  for (const row of rows) {
    const itemKey = String(row.stockItemId ?? row.stockItemName);
    const key = `${row.activityDate}|${itemKey}`;
    const group = groups.get(key) ?? {
      activityDate: row.activityDate,
      stockItemName: row.stockItemName,
      quantity: 0,
      totalValue: 0,
      totalProfit: 0,
      locations: new Map<string, number>(),
    };
    group.quantity += Number(row.quantity || 0);
    group.totalValue += Number(row.totalSales || 0);
    group.totalProfit += Number(row.costProfit || 0);
    sumMap(group.locations, row.locationName, Number(row.quantity || 0));
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      activityDate: group.activityDate,
      stockItemName: group.stockItemName,
      quantity: group.quantity,
      totalValue: group.totalValue,
      avgRate: group.quantity === 0 ? 0 : group.totalValue / group.quantity,
      profitPerBale: group.quantity === 0 ? 0 : group.totalProfit / group.quantity,
      totalProfit: group.totalProfit,
      locations: mapToBreakdown(group.locations),
    }))
    .sort((a, b) => {
      const date = b.activityDate.localeCompare(a.activityDate);
      if (date !== 0) return date;
      return a.stockItemName.localeCompare(b.stockItemName, undefined, { numeric: true, sensitivity: "base" });
    });
}

function breakdownTitle(label: string, rows: Array<{ name: string; quantity: number }>): string {
  return `${label}\n${rows.map((row) => `${row.name}: ${formatNumber(row.quantity, 0)}`).join("\n")}`;
}

function profitClassName(value: number): string {
  if (value > 0) return "text-emerald-500";
  if (value < 0) return "text-red-500";
  return "text-muted-foreground";
}

export default function StockInSalesReportDetail() {
  const { selectedCompany } = useCompany();
  const { formatAmount, selectedCurrency, convertToDisplay, displayCurrency } = useCurrencyContext();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const startDate = params.get("startDate") || "";
  const endDate = params.get("endDate") || "";
  const periodLabel = params.get("periodLabel") || `${startDate} – ${endDate}`;
  const locationIds = params.get("locationIds") || "";
  const stockGroupIds = params.get("stockGroupIds") || "";
  const search = params.get("search") || "";

  const baseParams = useMemo(() => {
    const query = new URLSearchParams({ startDate, endDate });
    if (locationIds) query.set("locationIds", locationIds);
    if (stockGroupIds) query.set("stockGroupIds", stockGroupIds);
    if (search) query.set("search", search);
    return query;
  }, [startDate, endDate, locationIds, stockGroupIds, search]);

  const queryUrl = useMemo(() => {
    const query = new URLSearchParams(baseParams);
    query.set("exportAll", "true");
    return `/api/reports/stock-in-sales/detail?${query.toString()}`;
  }, [baseParams]);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<DetailResponse, Error>({
    queryKey: [queryUrl, selectedCompany?.id],
    enabled: !!selectedCompany?.id && !!startDate && !!endDate,
    staleTime: 30_000,
  });

  const groupedStockIn = useMemo(() => groupStockInRows(data?.stockIn.rows || []), [data?.stockIn.rows]);
  const groupedSales = useMemo(() => groupSalesRows(data?.stockOut.rows || []), [data?.stockOut.rows]);
  const adjustmentRows = useMemo(() => data?.adjustments?.rows || [], [data?.adjustments?.rows]);
  const stockInTotals = useMemo(
    () =>
      groupedStockIn.reduce(
        (totals, row) => ({
          quantity: totals.quantity + row.quantity,
          value: totals.value + row.totalValue,
        }),
        { quantity: 0, value: 0 }
      ),
    [groupedStockIn]
  );
  const salesTotals = useMemo(
    () =>
      groupedSales.reduce(
        (totals, row) => ({
          quantity: totals.quantity + row.quantity,
          value: totals.value + row.totalValue,
          totalProfit: totals.totalProfit + row.totalProfit,
        }),
        { quantity: 0, value: 0, totalProfit: 0 }
      ),
    [groupedSales]
  );
  const adjustmentTotals = useMemo(
    () =>
      adjustmentRows.reduce(
        (totals, row) => {
          if (row.direction === "In") {
            totals.inQty += Number(row.quantity || 0);
            totals.inValue += Number(row.totalValue || 0);
          } else {
            totals.outQty += Number(row.quantity || 0);
            totals.outValue += Number(row.totalValue || 0);
          }
          return totals;
        },
        { inQty: 0, inValue: 0, outQty: 0, outValue: 0 }
      ),
    [adjustmentRows]
  );

  const summary = data?.summary ?? EMPTY_METRICS;
  const roundedMoney = (value: number) =>
    value < 0 ? `-${formatAmount(Math.round(Math.abs(value)))}` : formatAmount(Math.round(value));
  const rate = (value: number) => {
    const converted = convertToDisplay(value);
    if (displayCurrency && selectedCurrency === displayCurrency && Number.isFinite(converted)) {
      // Preserve Mali's existing report-rate precision rather than changing
      // CFA presentation as a side effect of introducing ZMW.
      if (displayCurrency === "CFA") return `CFA ${formatNumber(converted, 2)}`;
      return formatMoneyDisplay(converted, { currency: displayCurrency });
    }
    return `$ ${formatNumber(value, 2)}`;
  };
  const displayDate = (value: string) => {
    try {
      return formatDisplayDate(parseISO(value));
    } catch {
      return value;
    }
  };

  const exportExcel = async () => {
    setIsExporting(true);
    try {
      const exportParams = new URLSearchParams(baseParams);
      exportParams.set("exportAll", "true");
      const detailResponse = await fetch(
        "/api/reports/stock-in-sales/detail?" + exportParams.toString(),
        { credentials: "include" },
      );
      if (!detailResponse.ok) throw new Error("Failed to load export details");
      const exportData = (await detailResponse.json()) as DetailResponse;

      // Do not download a 20,000-row truncated "complete" workbook.
      if (exportData.stockIn.truncated || exportData.stockOut.truncated ||
          exportData.adjustments?.truncated) {
        throw new Error("Stock flow detail exceeds the API export limit; the workbook would be incomplete");
      }
      const stockIn = groupStockInRows(exportData.stockIn.rows);
      const sales = groupSalesRows(exportData.stockOut.rows);
      const adjustments = exportData.adjustments?.rows || [];
      const summaryRows: Array<{ metric: string; value: string | number }> = [
        { metric: "Period", value: periodLabel },
        { metric: "Opening Stock Qty", value: exportData.summary.openingStockQty },
        { metric: "Opening Stock Value", value: exportData.summary.openingStockValue },
        { metric: "Stock In Qty", value: exportData.summary.stockInQty },
        { metric: "Stock In Value", value: exportData.summary.stockInValue },
        { metric: "Stock Adjustments Net Qty", value: exportData.summary.stockAdjustmentQty },
        { metric: "Total Available Qty", value: exportData.summary.totalAvailableQty },
        { metric: "Stock Out Qty", value: exportData.summary.stockOutQty },
        { metric: "Closing Stock Qty", value: exportData.summary.closingStockQty },
        { metric: "Closing Stock Value", value: exportData.summary.closingStockValue },
        { metric: "Total Sales", value: exportData.summary.totalSales },
        { metric: "Cost of Sales", value: exportData.summary.costOfSales },
        { metric: "Gross Profit", value: exportData.summary.costProfit },
        { metric: "Average Profit / Bale", value: exportData.summary.avgProfitPerBale },
      ];
      const stockInRows = stockIn.map(row => ({
        Dates: row.dates.join(", "),
        Containers: row.containers.map(entry =>
          entry.name + " (" + formatNumber(entry.quantity, 0) + ")"
        ).join(", "),
        Locations: row.locations.map(entry =>
          entry.name + " (" + formatNumber(entry.quantity, 0) + ")"
        ).join(", "),
        Item: row.stockItemName,
        Qty: row.quantity,
        "Avg Rate": row.avgRate,
        Value: row.totalValue,
      }));
      const adjustmentRows = adjustments.map(row => ({
        Date: row.activityDate,
        Voucher: row.voucherNumber,
        Type: row.adjustmentType,
        Direction: row.direction === "In" ? "Stock In" : "Stock Out",
        Location: row.locationName,
        Item: row.stockItemName,
        Qty: row.quantity,
        Rate: row.unitRate,
        Value: row.totalValue,
      }));
      const salesRows = sales.map(row => ({
        Date: row.activityDate,
        Locations: row.locations.map(entry =>
          entry.name + " (" + formatNumber(entry.quantity, 0) + ")"
        ).join(", "),
        Item: row.stockItemName,
        Qty: row.quantity,
        "Avg Rate": row.avgRate,
        Value: row.totalValue,
        "Profit / Bale": row.profitPerBale,
        "Total Profit": row.totalProfit,
      }));
      const { columnsFromOperationalRows, exportOperationalWorkbook } = await import(
        "@/lib/operationalExcelExport"
      );
      const money = { "Avg Rate": "money" as const, Rate: "money" as const,
        Value: "money" as const, "Profit / Bale": "money" as const, "Total Profit": "money" as const,
        Qty: "decimal" as const };
      const safeLabel = periodLabel.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
      await exportOperationalWorkbook({
        title: "Stock Flow Details",
        companyName: selectedCompany?.name,
        currencyCode: "USD",
        fileName: "stock-flow-detail-" + (safeLabel || format(new Date(), "yyyy-MM-dd")) + ".xlsx",
        filters: [
          { label: "Period", value: periodLabel },
          { label: "Locations", value: locationIds || "All" },
          { label: "Stock groups", value: stockGroupIds || "All" },
          { label: "Search", value: search || "All" },
        ],
        sheets: [
          {
            name: "Summary",
            rows: summaryRows,
            columns: columnsFromOperationalRows(summaryRows, {
              orderedHeaders: ["metric", "value"],
            }),
          },
          {
            name: "Container Stock In",
            rows: stockInRows,
            columns: columnsFromOperationalRows(stockInRows, {
              orderedHeaders: ["Dates", "Containers", "Locations", "Item", "Qty", "Avg Rate", "Value"],
              types: money,
            }),
          },
          {
            name: "Stock Adjustments",
            rows: adjustmentRows,
            columns: columnsFromOperationalRows(adjustmentRows, {
              orderedHeaders: ["Date", "Voucher", "Type", "Direction", "Location", "Item", "Qty", "Rate", "Value"],
              types: money,
            }),
          },
          {
            name: "Sales",
            rows: salesRows,
            columns: columnsFromOperationalRows(salesRows, {
              orderedHeaders: [
                "Date", "Locations", "Item", "Qty", "Avg Rate",
                "Value", "Profit / Bale", "Total Profit",
              ],
              types: money,
            }),
          },
        ],
      });
    } catch (exportError: unknown) {
      toast({
        title: "Export failed",
        description: (exportError instanceof Error ? exportError.message : "") || "Unable to create the Excel file.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  if (!startDate || !endDate) {
    return (
      <div className="container mx-auto p-0 sm:p-6">
        <PageHeader title="Stock Flow Details" />
        <p className="mt-3 text-sm text-muted-foreground">A valid report period is required.</p>
        <Button className="mt-4" variant="outline" onClick={() => (window.location.href = "/stock-in-sales-report")}>
          Back to report
        </Button>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-6 p-0 sm:p-6">
      <PageHeader
        title="Stock Flow Details"
        onBack={() => window.history.back()}
        meta={
          <span>
            {periodLabel}
            {selectedCompany?.name ? ` · ${selectedCompany.name}` : ""}
          </span>
        }
      >
        <ErpReportExportMenu
          size="sm"
          className="gap-2 print:hidden"
          busy={isExporting}
          disabled={isLoading}
          options={[
            { id: "stock-flow-excel", label: "Export Excel", kind: "excel", onSelect: exportExcel },
            { id: "stock-flow-print", label: "Print / Save PDF", kind: "print", onSelect: () => window.print() },
          ]}
        />
      </PageHeader>

      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-[98px] rounded-xl" />)
        ) : (
          <>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Opening Stock</p>
              <div className="mt-auto grid grid-cols-2 gap-3 pt-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">Qty</p>
                  <p className="mt-1 whitespace-nowrap font-mono text-[17px] font-semibold leading-none tracking-tight tabular-nums">
                    {formatNumber(summary.openingStockQty, 0)}
                  </p>
                </div>
                <div className="min-w-0 text-right">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">Value</p>
                  <p className="mt-1 whitespace-nowrap font-mono text-[15px] font-semibold leading-none tracking-tight tabular-nums 2xl:text-[16px]">
                    {roundedMoney(summary.openingStockValue)}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Stock In Qty</p>
              <p className="mt-auto whitespace-nowrap pt-3 font-mono text-[19px] font-semibold leading-none tracking-tight tabular-nums">
                {formatNumber(summary.stockInQty, 0)}
              </p>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Stock Out</p>
              <p className="mt-auto whitespace-nowrap pt-3 font-mono text-[19px] font-semibold leading-none tracking-tight tabular-nums">
                {formatNumber(summary.stockOutQty, 0)}
              </p>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Closing / In Hand</p>
              <div className="mt-auto grid grid-cols-2 gap-3 pt-3">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">Qty</p>
                  <p className="mt-1 whitespace-nowrap font-mono text-[17px] font-semibold leading-none tracking-tight tabular-nums">
                    {formatNumber(summary.closingStockQty, 0)}
                  </p>
                </div>
                <div className="min-w-0 text-right">
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">Value</p>
                  <p className="mt-1 whitespace-nowrap font-mono text-[15px] font-semibold leading-none tracking-tight tabular-nums 2xl:text-[16px]">
                    {roundedMoney(summary.closingStockValue)}
                  </p>
                </div>
              </div>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Gross Profit</p>
              <p className="mt-auto whitespace-nowrap pt-3 font-mono text-[19px] font-semibold leading-none tracking-tight tabular-nums">
                {roundedMoney(summary.costProfit)}
              </p>
            </div>
            <div className="flex min-h-[98px] flex-col rounded-xl border bg-muted/20 px-3.5 py-3">
              <p className="text-[12px] font-medium leading-none text-muted-foreground">Avg Profit / Bale</p>
              <p className="mt-auto whitespace-nowrap pt-3 font-mono text-[19px] font-semibold leading-none tracking-tight tabular-nums">
                {roundedMoney(summary.avgProfitPerBale)}
              </p>
            </div>
          </>
        )}
      </div>

      {isFetching && !isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground print:hidden">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Refreshing details
        </div>
      )}

      {isError ? (
        <div className="rounded-xl border border-destructive/30 p-8 text-center">
          <TrendingDown className="mx-auto h-6 w-6 text-destructive" />
          <p className="mt-3 text-sm font-medium">Unable to load details</p>
          <p className="mt-1 text-xs text-muted-foreground">{error?.message}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <PackagePlus className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Container Stock In</h2>
              <span className="text-xs text-muted-foreground">
                {formatNumber(groupedStockIn.length, 0)} items · merged across all offloads
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border">
              <div className="max-h-[520px] overflow-auto">
                <Table className="min-w-[900px]" mobileLayout="cards">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Date</TableHead>
                      <TableHead>Container</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avg Rate</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={7}>
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : groupedStockIn.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                          No direct container offloads found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      <>
                        {groupedStockIn.map((row) => (
                          <TableRow key={row.key}>
                            <TableCell
                              title={
                                row.dates.length > 1
                                  ? `Offloaded on:\n${row.dates.map(displayDate).join("\n")}`
                                  : undefined
                              }
                              className={
                                row.dates.length > 1 ? "cursor-help underline decoration-dotted underline-offset-4" : ""
                              }
                            >
                              {row.dates.length === 1 ? displayDate(row.dates[0]) : `${row.dates.length} dates`}
                            </TableCell>
                            <TableCell
                              className="cursor-help font-mono underline decoration-dotted underline-offset-4"
                              title={breakdownTitle("Containers / Qty", row.containers)}
                            >
                              {formatNumber(row.containers.length, 0)}{" "}
                              {row.containers.length === 1 ? "container" : "containers"}
                            </TableCell>
                            <TableCell
                              className={
                                row.locations.length > 1
                                  ? "cursor-help underline decoration-dotted underline-offset-4"
                                  : ""
                              }
                              title={
                                row.locations.length > 1 ? breakdownTitle("Locations / Qty", row.locations) : undefined
                              }
                            >
                              {row.locations.length === 1
                                ? row.locations[0].name
                                : `${formatNumber(row.locations.length, 0)} locations`}
                            </TableCell>
                            <TableCell className="font-medium">{row.stockItemName}</TableCell>
                            <TableCell className="text-right font-mono">{formatNumber(row.quantity, 0)}</TableCell>
                            <TableCell className="text-right font-mono">{rate(row.avgRate)}</TableCell>
                            <TableCell className="text-right font-mono">{formatAmount(row.totalValue)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="sticky bottom-0 z-10 border-t-2 bg-muted/95 font-semibold hover:bg-muted/95">
                          <TableCell colSpan={4} className="uppercase tracking-wide">
                            Total
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatNumber(stockInTotals.quantity, 0)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(stockInTotals.value)}</TableCell>
                        </TableRow>
                      </>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <PackagePlus className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Stock Adjustments</h2>
              <span className="text-xs text-muted-foreground">
                {formatNumber(adjustmentRows.length, 0)} lines · In {formatNumber(adjustmentTotals.inQty, 0)} · Out{" "}
                {formatNumber(adjustmentTotals.outQty, 0)}
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border">
              <div className="max-h-[420px] overflow-auto">
                <Table className="min-w-[1050px]" mobileLayout="cards">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Date</TableHead>
                      <TableHead>Voucher</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      Array.from({ length: 3 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={9}>
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : adjustmentRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                          No stock adjustments found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      adjustmentRows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell>{displayDate(row.activityDate)}</TableCell>
                          <TableCell className="font-mono">{row.voucherNumber}</TableCell>
                          <TableCell>{row.adjustmentType}</TableCell>
                          <TableCell className="font-medium">
                            {row.direction === "In" ? "Stock In" : "Stock Out"}
                          </TableCell>
                          <TableCell>{row.locationName}</TableCell>
                          <TableCell className="font-medium">{row.stockItemName}</TableCell>
                          <TableCell className="text-right font-mono">{formatNumber(row.quantity, 0)}</TableCell>
                          <TableCell className="text-right font-mono">{rate(row.unitRate)}</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(row.totalValue)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <PackageMinus className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Sales</h2>
              <span className="text-xs text-muted-foreground">
                {formatNumber(groupedSales.length, 0)} item/day totals
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border">
              <div className="max-h-[520px] overflow-auto">
                <Table className="min-w-[1100px]" mobileLayout="cards">
                  <TableHeader>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableHead>Date</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avg Rate</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead className="text-right">Profit / Bale</TableHead>
                      <TableHead className="text-right">Total Profit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell colSpan={8}>
                            <Skeleton className="h-5 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : groupedSales.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                          No sales found.
                        </TableCell>
                      </TableRow>
                    ) : (
                      <>
                        {groupedSales.map((row) => (
                          <TableRow key={row.key}>
                            <TableCell>{displayDate(row.activityDate)}</TableCell>
                            <TableCell
                              className={
                                row.locations.length > 1
                                  ? "cursor-help underline decoration-dotted underline-offset-4"
                                  : ""
                              }
                              title={
                                row.locations.length > 1
                                  ? breakdownTitle("Locations / Qty Sold", row.locations)
                                  : undefined
                              }
                            >
                              {row.locations.length === 1
                                ? row.locations[0].name
                                : `${formatNumber(row.locations.length, 0)} locations`}
                            </TableCell>
                            <TableCell className="font-medium">{row.stockItemName}</TableCell>
                            <TableCell className="text-right font-mono">{formatNumber(row.quantity, 0)}</TableCell>
                            <TableCell className="text-right font-mono">{rate(row.avgRate)}</TableCell>
                            <TableCell className="text-right font-mono">{formatAmount(row.totalValue)}</TableCell>
                            <TableCell
                              className={`text-right font-mono font-medium ${profitClassName(row.profitPerBale)}`}
                            >
                              {rate(row.profitPerBale)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-mono font-medium ${profitClassName(row.totalProfit)}`}
                            >
                              {formatAmount(row.totalProfit)}
                            </TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="sticky bottom-0 z-10 border-t-2 bg-muted/95 font-semibold hover:bg-muted/95">
                          <TableCell colSpan={3} className="uppercase tracking-wide">
                            Total
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatNumber(salesTotals.quantity, 0)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(salesTotals.value)}</TableCell>
                          <TableCell className="text-right text-muted-foreground">—</TableCell>
                          <TableCell className={`text-right font-mono ${profitClassName(salesTotals.totalProfit)}`}>
                            {formatAmount(salesTotals.totalProfit)}
                          </TableCell>
                        </TableRow>
                      </>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          </section>
        </>
      )}

      {(data?.stockIn.truncated || data?.stockOut.truncated || data?.adjustments?.truncated) && (
        <p className="text-xs text-amber-600">
          Detail data reached the 20,000-line safety limit; totals above remain based on the report summary.
        </p>
      )}

      <ErpReportPrintFooter
        title="Stock Flow Details"
        companyName={selectedCompany?.name}
        fromDate={startDate}
        toDate={endDate}
      />
    </div>
  );
}
