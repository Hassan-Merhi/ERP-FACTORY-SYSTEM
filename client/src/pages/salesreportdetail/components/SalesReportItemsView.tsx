/**
 * Item-grouped view of the Sales Report Detail page: expandable item rows,
 * per-location sub-rows, and the individual sale records beneath.
 *
 * Extracted from SalesReportDetail.tsx during the P1 god-file split. Purely
 * presentational — grouping, colors, and P/L filtering live in
 * useSalesReportDetailModel. The mobile rendering stays in
 * SalesReportItemMobileView, matching the pre-extraction split.
 */

import { Table, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import { profitColor } from "../utils";
import type { SalesReportItemsViewProps } from "./SalesReportItemsViewTypes";
import { SalesReportItemsViewTableBody } from "./SalesReportItemsViewTableBody";

export function SalesReportItemsView({
  itemGroups,
  expandedItems,
  toggleItem,
  expandedLocations,
  toggleLocation,
  locationColorMap,
  multipleLocations,
  col,
  plFilter,
  totalQty,
  totalSales,
  totalCost,
  totalConfiguredCost,
  costProfit,
  configuredProfit,
  formatAmount,
}: SalesReportItemsViewProps) {
  return (
    <>
      <div className="hidden md:block">
        <Table mobileLayout="cards">
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead className="w-6"></TableHead>
              <TableHead>Item / Location</TableHead>
              {col("qty") && <TableHead className="text-right">Qty</TableHead>}
              {col("costPrice") && <TableHead className="text-right">Cost Price</TableHead>}
              {col("pricePerBale") && <TableHead className="text-right">Price / Bale</TableHead>}
              {col("costProfitBale") && <TableHead className="text-right">Cost Profit / Bale</TableHead>}
              {col("hassanPrice") && <TableHead className="text-right">Hassan's Price</TableHead>}
              {col("hassanProfitBale") && <TableHead className="text-right">Hassan's Profit / Bale</TableHead>}
              {col("hassanProfitTotal") && <TableHead className="text-right">Hassan's Profit</TableHead>}
              {col("costProfitTotal") && <TableHead className="text-right">Cost Profit</TableHead>}
            </TableRow>
          </TableHeader>
          <SalesReportItemsViewTableBody
            col={col}
            expandedItems={expandedItems}
            expandedLocations={expandedLocations}
            formatAmount={formatAmount}
            itemGroups={itemGroups}
            locationColorMap={locationColorMap}
            multipleLocations={multipleLocations}
            toggleItem={toggleItem}
            toggleLocation={toggleLocation}
          />
          <TableFooter className="sticky bottom-0 bg-background border-t">
            <TableRow className="font-semibold">
              <TableCell></TableCell>
              <TableCell>
                Total ({itemGroups.length} item{itemGroups.length !== 1 ? "s" : ""}
                {plFilter !== "all" ? `, ${plFilter === "gain" ? "gaining" : "losing"} only` : ""})
              </TableCell>
              {col("qty") && <TableCell className="text-right font-mono">{formatNumber(totalQty)}</TableCell>}
              {col("costPrice") && (
                <TableCell className="text-right font-mono text-muted-foreground">
                  {totalQty > 0 ? formatAmount(totalCost / totalQty) : "—"}
                </TableCell>
              )}
              {col("pricePerBale") && (
                <TableCell className="text-right font-mono">
                  {totalQty > 0 ? formatAmount(totalSales / totalQty) : "—"}
                </TableCell>
              )}
              {col("costProfitBale") && (
                <TableCell className={`text-right font-mono ${profitColor(costProfit)}`}>
                  {totalQty > 0 ? formatAmount(Math.abs(costProfit) / totalQty) : "—"}
                </TableCell>
              )}
              {col("hassanPrice") && (
                <TableCell className="text-right font-mono text-muted-foreground">
                  {totalQty > 0 ? formatAmount(totalConfiguredCost / totalQty) : "—"}
                </TableCell>
              )}
              {col("hassanProfitBale") && (
                <TableCell className={`text-right font-mono ${profitColor(configuredProfit)}`}>
                  {totalQty > 0 ? formatAmount(Math.abs(configuredProfit) / totalQty) : "—"}
                </TableCell>
              )}
              {col("hassanProfitTotal") && (
                <TableCell className={`text-right font-mono ${profitColor(configuredProfit)}`}>
                  {formatAmount(Math.abs(configuredProfit))}
                </TableCell>
              )}
              {col("costProfitTotal") && (
                <TableCell className={`text-right font-mono ${profitColor(costProfit)}`}>
                  {formatAmount(Math.abs(costProfit))}
                </TableCell>
              )}
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </>
  );
}
