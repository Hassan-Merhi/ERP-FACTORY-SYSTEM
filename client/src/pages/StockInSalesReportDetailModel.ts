// Extracted from ./StockInSalesReportDetail.tsx: state, queries and handlers for StockInSalesReportDetail.
import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { formatNumber } from "@/lib/formatNumber";
import {
  EMPTY_METRICS,
  groupStockInRows,
  groupSalesRows,
  type DetailResponse,
} from "./StockInSalesReportDetailModelHelpers";
export {
  EMPTY_METRICS,
  sumMap,
  mapToBreakdown,
  groupStockInRows,
  groupSalesRows,
  breakdownTitle,
  profitClassName,
  type StockAdjustmentRow,
  type PagedRows,
  type DetailResponse,
  type GroupedStockInRow,
  type GroupedSalesRow,
} from "./StockInSalesReportDetailModelHelpers";

export function useStockInSalesReportDetailModel() {
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
      const detailResponse = await fetch("/api/reports/stock-in-sales/detail?" + exportParams.toString(), {
        credentials: "include",
      });
      if (!detailResponse.ok) throw new Error("Failed to load export details");
      const exportData = (await detailResponse.json()) as DetailResponse;

      // Do not download a 20,000-row truncated "complete" workbook.
      if (exportData.stockIn.truncated || exportData.stockOut.truncated || exportData.adjustments?.truncated) {
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
      const stockInRows = stockIn.map((row) => ({
        Dates: row.dates.join(", "),
        Containers: row.containers.map((entry) => entry.name + " (" + formatNumber(entry.quantity, 0) + ")").join(", "),
        Locations: row.locations.map((entry) => entry.name + " (" + formatNumber(entry.quantity, 0) + ")").join(", "),
        Item: row.stockItemName,
        Qty: row.quantity,
        "Avg Rate": row.avgRate,
        Value: row.totalValue,
      }));
      const adjustmentRows = adjustments.map((row) => ({
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
      const salesRows = sales.map((row) => ({
        Date: row.activityDate,
        Locations: row.locations.map((entry) => entry.name + " (" + formatNumber(entry.quantity, 0) + ")").join(", "),
        Item: row.stockItemName,
        Qty: row.quantity,
        "Avg Rate": row.avgRate,
        Value: row.totalValue,
        "Profit / Bale": row.profitPerBale,
        "Total Profit": row.totalProfit,
      }));
      const { columnsFromOperationalRows, exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      const money = {
        "Avg Rate": "money" as const,
        Rate: "money" as const,
        Value: "money" as const,
        "Profit / Bale": "money" as const,
        "Total Profit": "money" as const,
        Qty: "decimal" as const,
      };
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
                "Date",
                "Locations",
                "Item",
                "Qty",
                "Avg Rate",
                "Value",
                "Profit / Bale",
                "Total Profit",
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

  return {
    selectedCompany,
    formatAmount,
    isExporting,
    startDate,
    endDate,
    periodLabel,
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
    groupedStockIn,
    groupedSales,
    adjustmentRows,
    stockInTotals,
    salesTotals,
    adjustmentTotals,
    summary,
    roundedMoney,
    rate,
    displayDate,
    exportExcel,
  };
}

export type StockInSalesReportDetailModel = ReturnType<typeof useStockInSalesReportDetailModel>;
