// Extracted from ./StockItemHistory.tsx
import { CardContent } from "@/components/ui/card";
import {
  CoreErpSummaryGrid,
  CoreErpSummaryItem,
  CoreErpSummaryLabel,
  CoreErpSummaryValue,
} from "@/components/ui/core-erp-mobile";
import { ErpListTable } from "@/erp-core";
import {
  ResponsiveDataList,
  ResponsiveDataListField,
  ResponsiveDataListFields,
  ResponsiveDataListHeader,
  ResponsiveDataListItem,
  ResponsiveDataListTitle,
} from "@/components/ui/responsive-data-list";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useStockItemHistoryState } from "./useStockItemHistoryState";

export function StockItemHistoryCardContent({
  data,
  formatAmount,
  formatNumber,
  handleMonthClick,
}: Pick<ReturnType<typeof useStockItemHistoryState>, "data" | "formatAmount" | "formatNumber" | "handleMonthClick">) {
  return (
    <CardContent>
      <div className="hidden md:block phone-land:hidden">
        <ErpListTable
          pageKey="stock-item-monthly-history"
          minimumWidth="52rem"
          scrollLabel="Stock item monthly summary"
        >
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
        </ErpListTable>
      </div>

      <div className="space-y-3 md:hidden phone-land:block">
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
              <p className="mt-1 wrap-break-word text-xs text-muted-foreground">
                {formatAmount(data.grandTotal.inwardValue)}
              </p>
            </CoreErpSummaryItem>
            <CoreErpSummaryItem>
              <CoreErpSummaryLabel>Total outwards</CoreErpSummaryLabel>
              <CoreErpSummaryValue>{formatNumber(data.grandTotal.outwardQty, 0)}</CoreErpSummaryValue>
              <p className="mt-1 wrap-break-word text-xs text-muted-foreground">
                {formatAmount(data.grandTotal.outwardValue)}
              </p>
            </CoreErpSummaryItem>
            <CoreErpSummaryItem>
              <CoreErpSummaryLabel>Closing balance</CoreErpSummaryLabel>
              <CoreErpSummaryValue>{formatNumber(data.grandTotal.closingQty, 0)}</CoreErpSummaryValue>
              <p className="mt-1 wrap-break-word text-xs text-muted-foreground">
                {formatAmount(data.grandTotal.closingValue)}
              </p>
            </CoreErpSummaryItem>
          </CoreErpSummaryGrid>
        )}
      </div>
    </CardContent>
  );
}
