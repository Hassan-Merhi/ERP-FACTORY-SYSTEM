import { Calendar } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CoreErpHeaderActions, CoreErpPage } from "@/components/ui/core-erp-mobile";
import { PageHeader } from "@/components/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { PeriodFilter } from "@/components/ui/period-filter";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useStockItemHistoryState } from "./useStockItemHistoryState";
import { StockItemHistoryCardContent } from "./StockItemHistoryCardContent";

export default function StockItemHistory() {
  const {
    handleBack,
    formatAmount,
    selectedYear,
    setSelectedYear,
    periodFilter,
    setPeriodFilter,
    isLoading,
    isError,
    data,
    refetch,
    years,
    chartData,
    handleMonthClick,
    formatNumber,
  } = useStockItemHistoryState();

  if (isLoading) {
    return (
      <CoreErpPage className="container mx-auto space-y-6 p-0 sm:p-4">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-[400px] w-full" />
      </CoreErpPage>
    );
  }

  if (isError && !data) {
    return (
      <CoreErpPage className="container mx-auto p-0 sm:p-4">
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" />
      </CoreErpPage>
    );
  }

  return (
    <CoreErpPage className="container mx-auto p-0 sm:p-4">
      <PageHeader
        title="Stock Item Monthly Summary"
        onBack={handleBack}
        meta={
          data?.stockItem && (
            <span className="wrap-break-word" data-testid="text-item-name">
              {data.stockItem.name} ({data.stockItem.code})
            </span>
          )
        }
      >
        <CoreErpHeaderActions aria-label="Stock history filters">
          <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />
          <RowsExportMenu
            title={`${data?.stockItem.name ?? "Stock Item"} Monthly Summary ${selectedYear}`}
            sheetName="Monthly Summary"
            rows={data?.monthlyData ?? []}
            columns={[
              { header: "Month", value: (m) => m.monthName },
              { header: "Inwards Quantity", value: (m) => (m.inwardQty > 0 ? m.inwardQty : null), type: "number" },
              { header: "Inwards Value", value: (m) => (m.inwardValue > 0 ? m.inwardValue : null), type: "number" },
              { header: "Outwards Quantity", value: (m) => (m.outwardQty > 0 ? m.outwardQty : null), type: "number" },
              {
                header: "Outwards Value",
                value: (m) => (m.outwardValue > 0 ? m.outwardValue : null),
                type: "number",
              },
              { header: "Closing Quantity", value: (m) => m.closingQty || null, type: "number" },
              { header: "Closing Value", value: (m) => m.closingValue || null, type: "number" },
            ]}
            footer={
              data
                ? [
                    "Grand Total",
                    data.grandTotal.inwardQty || 0,
                    data.grandTotal.inwardValue || 0,
                    data.grandTotal.outwardQty || 0,
                    data.grandTotal.outwardValue || 0,
                    data.grandTotal.closingQty || 0,
                    data.grandTotal.closingValue || 0,
                  ]
                : undefined
            }
            resource="erp.stock_items"
            period={{ from: periodFilter.fromDate, to: periodFilter.toDate }}
          />
          <div className="flex min-w-0 items-center gap-2">
            <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Select value={selectedYear} onValueChange={setSelectedYear}>
              <SelectTrigger className="w-full sm:w-[120px]" data-testid="select-year">
                <SelectValue placeholder="Year" />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={y.toString()}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CoreErpHeaderActions>
      </PageHeader>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="wrap-break-word text-lg">Monthly Summary - {selectedYear}</CardTitle>
        </CardHeader>
        <StockItemHistoryCardContent
          data={data}
          formatAmount={formatAmount}
          formatNumber={formatNumber}
          handleMonthClick={handleMonthClick}
        />
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Monthly Activity Chart</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[250px] sm:h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="name" className="text-xs" />
                <YAxis className="text-xs" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    borderColor: "hsl(var(--border))",
                    borderRadius: "var(--radius)",
                  }}
                />
                <Legend />
                <Bar dataKey="Inwards" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Outwards" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </CoreErpPage>
  );
}
