import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { useBackToParent } from "@/hooks/use-back-to-parent";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import { Calendar } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CoreErpHeaderActions,
  CoreErpPage,
  CoreErpSummaryGrid,
  CoreErpSummaryItem,
  CoreErpSummaryLabel,
  CoreErpSummaryValue,
} from "@/components/ui/core-erp-mobile";
import { PageHeader } from "@/components/PageHeader";
import {
  ResponsiveDataList,
  ResponsiveDataListField,
  ResponsiveDataListFields,
  ResponsiveDataListHeader,
  ResponsiveDataListItem,
  ResponsiveDataListTitle,
} from "@/components/ui/responsive-data-list";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";
import { PeriodFilter, getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

interface MonthlyData {
  month: number;
  monthName: string;
  inwardQty: number;
  inwardValue: number;
  outwardQty: number;
  outwardValue: number;
  closingQty: number;
  closingValue: number;
}

interface StockItemSummary {
  stockItem: {
    id: number;
    code: string;
    name: string;
    uom: string;
  };
  year: number;
  monthlyData: MonthlyData[];
  grandTotal: {
    inwardQty: number;
    inwardValue: number;
    outwardQty: number;
    outwardValue: number;
    closingQty: number;
    closingValue: number;
  };
}

export default function StockItemHistory() {
  const params = useParams();
  const stockItemId = parseInt(params.id || "0");
  const [_location, navigate] = useLocation();
  const handleBack = useBackToParent();
  const { formatAmount } = useCurrencyContext();

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear.toString());
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_year"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  useEscapeToParent("/stock-items");

  const { data, isLoading } = useQuery<StockItemSummary>({
    queryKey: [
      `/api/stock-items/${stockItemId}/monthly-summary`,
      { year: selectedYear, startDate: periodFilter.fromDate, endDate: periodFilter.toDate },
    ],
    queryFn: async () => {
      const response = await fetch(
        `/api/stock-items/${stockItemId}/monthly-summary?year=${selectedYear}&startDate=${periodFilter.fromDate}&endDate=${periodFilter.toDate}`,
        {
          credentials: "include",
        }
      );
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
    enabled: stockItemId > 0,
  });

  const years = [];
  for (let y = currentYear; y >= currentYear - 5; y--) {
    years.push(y);
  }

  const chartData =
    data?.monthlyData.map((m) => ({
      name: m.monthName.substring(0, 3),
      Inwards: m.inwardQty,
      Outwards: m.outwardQty,
    })) || [];

  const handleMonthClick = (month: number) => {
    navigate(`/stock-items/${stockItemId}/history/${selectedYear}/${month}`);
  };

  const formatNumber = (num: number, decimals = 2) => {
    return num.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  };

  if (isLoading) {
    return (
      <CoreErpPage className="container mx-auto space-y-6 p-0 sm:p-4">
        <Skeleton className="h-8 w-64 max-w-full" />
        <Skeleton className="h-[400px] w-full" />
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
            <span className="break-words" data-testid="text-item-name">
              {data.stockItem.name} ({data.stockItem.code})
            </span>
          )
        }
      >
        <CoreErpHeaderActions aria-label="Stock history filters">
          <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter" />
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
          <CardTitle className="break-words text-lg">Monthly Summary - {selectedYear}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="hidden md:block">
            <Table minimumWidth="52rem" scrollLabel="Stock item monthly summary">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead rowSpan={2} className="align-bottom border-r">
                    Particulars
                  </TableHead>
                  <TableHead colSpan={2} className="border-r text-center">
                    Inwards
                  </TableHead>
                  <TableHead colSpan={2} className="border-r text-center">
                    Outwards
                  </TableHead>
                  <TableHead colSpan={2} className="text-center">
                    Closing Balance
                  </TableHead>
                </TableRow>
                <TableRow>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="border-r text-right">Value</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="border-r text-right">Value</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.monthlyData.map((month) => {
                  const hasData = month.inwardQty > 0 || month.outwardQty > 0 || month.closingQty !== 0;
                  return (
                    <TableRow
                      key={month.month}
                      className={hasData ? "cursor-pointer hover:bg-muted/50" : ""}
                      onClick={() => hasData && handleMonthClick(month.month)}
                      data-testid={`row-month-${month.month}`}
                    >
                      <TableCell className="border-r font-medium">{month.monthName}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {month.inwardQty > 0 ? formatNumber(month.inwardQty, 0) : ""}
                      </TableCell>
                      <TableCell className="border-r text-right tabular-nums">
                        {month.inwardValue > 0 ? formatAmount(month.inwardValue) : ""}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {month.outwardQty > 0 ? formatNumber(month.outwardQty, 0) : ""}
                      </TableCell>
                      <TableCell className="border-r text-right tabular-nums">
                        {month.outwardValue > 0 ? formatAmount(month.outwardValue) : ""}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {month.closingQty !== 0 ? formatNumber(month.closingQty, 0) : ""}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {month.closingValue !== 0 ? formatAmount(month.closingValue) : ""}
                      </TableCell>
                    </TableRow>
                  );
                })}

                <TableRow className="bg-muted/50 font-bold">
                  <TableCell className="border-r">Grand Total</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(data?.grandTotal.inwardQty || 0, 0)}
                  </TableCell>
                  <TableCell className="border-r text-right tabular-nums">
                    {formatAmount(data?.grandTotal.inwardValue || 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(data?.grandTotal.outwardQty || 0, 0)}
                  </TableCell>
                  <TableCell className="border-r text-right tabular-nums">
                    {formatAmount(data?.grandTotal.outwardValue || 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(data?.grandTotal.closingQty || 0, 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAmount(data?.grandTotal.closingValue || 0)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div className="space-y-3 md:hidden">
            <ResponsiveDataList>
              {data?.monthlyData.map((month) => {
                const hasData = month.inwardQty > 0 || month.outwardQty > 0 || month.closingQty !== 0;
                return (
                  <ResponsiveDataListItem
                    key={month.month}
                    role={hasData ? "button" : undefined}
                    tabIndex={hasData ? 0 : undefined}
                    aria-disabled={!hasData}
                    className={hasData ? "cursor-pointer" : "opacity-50"}
                    onClick={() => hasData && handleMonthClick(month.month)}
                    onKeyDown={(event) => {
                      if (!hasData || (event.key !== "Enter" && event.key !== " ")) return;
                      event.preventDefault();
                      handleMonthClick(month.month);
                    }}
                    data-testid={`row-month-${month.month}`}
                  >
                    <ResponsiveDataListHeader>
                      <ResponsiveDataListTitle>{month.monthName}</ResponsiveDataListTitle>
                    </ResponsiveDataListHeader>
                    <ResponsiveDataListFields>
                      <ResponsiveDataListField
                        label="Inward quantity"
                        value={month.inwardQty > 0 ? formatNumber(month.inwardQty, 0) : "—"}
                      />
                      <ResponsiveDataListField
                        label="Inward value"
                        value={month.inwardValue > 0 ? formatAmount(month.inwardValue) : "—"}
                      />
                      <ResponsiveDataListField
                        label="Outward quantity"
                        value={month.outwardQty > 0 ? formatNumber(month.outwardQty, 0) : "—"}
                      />
                      <ResponsiveDataListField
                        label="Outward value"
                        value={month.outwardValue > 0 ? formatAmount(month.outwardValue) : "—"}
                      />
                      <ResponsiveDataListField
                        label="Closing quantity"
                        value={month.closingQty !== 0 ? formatNumber(month.closingQty, 0) : "—"}
                      />
                      <ResponsiveDataListField
                        label="Closing value"
                        value={month.closingValue !== 0 ? formatAmount(month.closingValue) : "—"}
                      />
                    </ResponsiveDataListFields>
                  </ResponsiveDataListItem>
                );
              })}
            </ResponsiveDataList>

            {data && (
              <CoreErpSummaryGrid>
                <CoreErpSummaryItem>
                  <CoreErpSummaryLabel>Total inwards</CoreErpSummaryLabel>
                  <CoreErpSummaryValue>{formatNumber(data.grandTotal.inwardQty, 0)}</CoreErpSummaryValue>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {formatAmount(data.grandTotal.inwardValue)}
                  </p>
                </CoreErpSummaryItem>
                <CoreErpSummaryItem>
                  <CoreErpSummaryLabel>Total outwards</CoreErpSummaryLabel>
                  <CoreErpSummaryValue>{formatNumber(data.grandTotal.outwardQty, 0)}</CoreErpSummaryValue>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {formatAmount(data.grandTotal.outwardValue)}
                  </p>
                </CoreErpSummaryItem>
                <CoreErpSummaryItem>
                  <CoreErpSummaryLabel>Closing balance</CoreErpSummaryLabel>
                  <CoreErpSummaryValue>{formatNumber(data.grandTotal.closingQty, 0)}</CoreErpSummaryValue>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {formatAmount(data.grandTotal.closingValue)}
                  </p>
                </CoreErpSummaryItem>
              </CoreErpSummaryGrid>
            )}
          </div>
        </CardContent>
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
