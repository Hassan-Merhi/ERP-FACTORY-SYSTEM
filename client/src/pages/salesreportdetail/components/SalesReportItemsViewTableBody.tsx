// Extracted from ./SalesReportItemsView.tsx
import { Fragment } from "react";
import { Badge } from "@/components/ui/badge";
import { TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { formatNumericValue, profitColor } from "../utils";
import type { SalesReportItemsViewProps } from "./SalesReportItemsViewTypes";

export function SalesReportItemsViewTableBody({
  col,
  expandedItems,
  expandedLocations,
  formatAmount,
  itemGroups,
  locationColorMap,
  multipleLocations,
  toggleItem,
  toggleLocation,
}: Pick<
  SalesReportItemsViewProps,
  | "col"
  | "expandedItems"
  | "expandedLocations"
  | "formatAmount"
  | "itemGroups"
  | "locationColorMap"
  | "multipleLocations"
  | "toggleItem"
  | "toggleLocation"
>) {
  return (
    <TableBody>
      {itemGroups.map((group) => {
        const itemKey = String(group.stockItemId);
        const isExpanded = expandedItems.has(itemKey);
        return (
          <Fragment key={itemKey}>
            {/* Item summary row */}
            <TableRow
              key={`item-${itemKey}`}
              data-testid={`row-item-${itemKey}`}
              className="cursor-pointer bg-muted/30 hover-elevate font-medium"
              onClick={() => toggleItem(itemKey)}
            >
              <TableCell className="py-2 pr-0 w-6">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </TableCell>
              <TableCell className="py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span>{group.stockItemName}</span>
                  {multipleLocations && group.locationBreakdown.length > 1 ? (
                    <div className="flex items-center gap-1">
                      {group.locationBreakdown.map((loc) => {
                        const color = locationColorMap.get(loc.locationKey);
                        return color ? (
                          <span
                            key={loc.locationKey}
                            title={loc.locationName}
                            className={`inline-block h-2 w-2 rounded-full ${color.dot}`}
                          />
                        ) : null;
                      })}
                      <span className="text-xs text-muted-foreground">{group.locationBreakdown.length} locs</span>
                    </div>
                  ) : (
                    <Badge variant="secondary" className="text-xs font-normal">
                      {group.locationBreakdown.length} loc
                      {group.locationBreakdown.length !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </div>
              </TableCell>
              {col("qty") && (
                <TableCell className="text-right font-mono py-2">{formatNumber(group.totalQty)}</TableCell>
              )}
              {col("costPrice") && (
                <TableCell className="text-right font-mono py-2 text-muted-foreground">
                  {group.totalQty > 0 ? formatAmount(group.totalCost / group.totalQty) : "—"}
                </TableCell>
              )}
              {col("pricePerBale") && (
                <TableCell className="text-right font-mono py-2">
                  {group.totalQty > 0 ? formatAmount(group.totalSales / group.totalQty) : "—"}
                </TableCell>
              )}
              {col("costProfitBale") && (
                <TableCell className={`text-right font-mono py-2 ${profitColor(group.costProfit)}`}>
                  {group.totalQty > 0 ? formatAmount(Math.abs(group.costProfit) / group.totalQty) : "—"}
                </TableCell>
              )}
              {col("hassanPrice") && (
                <TableCell className="text-right font-mono py-2 text-muted-foreground">
                  {group.totalQty > 0 ? formatAmount(group.totalConfiguredCost / group.totalQty) : "—"}
                </TableCell>
              )}
              {col("hassanProfitBale") && (
                <TableCell className={`text-right font-mono py-2 ${profitColor(group.configuredProfit)}`}>
                  {group.totalQty > 0 ? formatAmount(Math.abs(group.configuredProfit) / group.totalQty) : "—"}
                </TableCell>
              )}
              {col("hassanProfitTotal") && (
                <TableCell className={`text-right font-mono py-2 ${profitColor(group.configuredProfit)}`}>
                  {formatAmount(Math.abs(group.configuredProfit))}
                </TableCell>
              )}
              {col("costProfitTotal") && (
                <TableCell className={`text-right font-mono py-2 ${profitColor(group.costProfit)}`}>
                  {formatAmount(Math.abs(group.costProfit))}
                </TableCell>
              )}
            </TableRow>

            {/* Expanded: per-location totals */}
            {isExpanded &&
              group.locationBreakdown.map((loc) => {
                const locRowKey = `${itemKey}-${loc.locationKey}`;
                const isLocExpanded = expandedLocations.has(locRowKey);
                return (
                  <Fragment key={locRowKey}>
                    {/* Location summary row for this item */}
                    <TableRow
                      key={`loc-${locRowKey}`}
                      data-testid={`row-loc-${locRowKey}`}
                      className="cursor-pointer hover-elevate text-sm"
                      onClick={() => toggleLocation(locRowKey)}
                    >
                      <TableCell className="py-1.5 pr-0 w-6 pl-8">
                        {isLocExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="py-1.5 pl-4">
                        <div className="flex items-center gap-2">
                          {multipleLocations &&
                            (() => {
                              const color = locationColorMap.get(loc.locationKey);
                              return color ? (
                                <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${color.dot}`} />
                              ) : null;
                            })()}
                          <span
                            className={
                              multipleLocations
                                ? (locationColorMap.get(loc.locationKey)?.text ?? "text-muted-foreground")
                                : "text-muted-foreground"
                            }
                          >
                            {loc.locationName}
                          </span>
                          {multipleLocations ? (
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded-sm text-xs font-normal ${locationColorMap.get(loc.locationKey)?.badge ?? ""}`}
                            >
                              {loc.items.length} sale{loc.items.length !== 1 ? "s" : ""}
                            </span>
                          ) : (
                            <Badge variant="outline" className="text-xs font-normal">
                              {loc.items.length} sale{loc.items.length !== 1 ? "s" : ""}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      {col("qty") && (
                        <TableCell className="text-right font-mono py-1.5">{formatNumber(loc.totalQty)}</TableCell>
                      )}
                      {col("costPrice") && (
                        <TableCell className="text-right font-mono py-1.5 text-muted-foreground">
                          {loc.totalQty > 0 ? formatAmount(loc.totalCost / loc.totalQty) : "—"}
                        </TableCell>
                      )}
                      {col("pricePerBale") && (
                        <TableCell className="text-right font-mono py-1.5">
                          {loc.totalQty > 0 ? formatAmount(loc.totalSales / loc.totalQty) : "—"}
                        </TableCell>
                      )}
                      {col("costProfitBale") && (
                        <TableCell className={`text-right font-mono py-1.5 ${profitColor(loc.costProfit)}`}>
                          {loc.totalQty > 0 ? formatAmount(Math.abs(loc.costProfit) / loc.totalQty) : "—"}
                        </TableCell>
                      )}
                      {col("hassanPrice") && (
                        <TableCell className="text-right font-mono py-1.5 text-muted-foreground">
                          {loc.totalQty > 0 ? formatAmount(loc.totalConfiguredCost / loc.totalQty) : "—"}
                        </TableCell>
                      )}
                      {col("hassanProfitBale") && (
                        <TableCell className={`text-right font-mono py-1.5 ${profitColor(loc.configuredProfit)}`}>
                          {loc.totalQty > 0 ? formatAmount(Math.abs(loc.configuredProfit) / loc.totalQty) : "—"}
                        </TableCell>
                      )}
                      {col("hassanProfitTotal") && (
                        <TableCell className={`text-right font-mono py-1.5 ${profitColor(loc.configuredProfit)}`}>
                          {formatAmount(Math.abs(loc.configuredProfit))}
                        </TableCell>
                      )}
                      {col("costProfitTotal") && (
                        <TableCell className={`text-right font-mono py-1.5 ${profitColor(loc.costProfit)}`}>
                          {formatAmount(Math.abs(loc.costProfit))}
                        </TableCell>
                      )}
                    </TableRow>

                    {/* Individual sale records within this location */}
                    {isLocExpanded &&
                      loc.items.map((item) => {
                        const qty = parseFloat(item.quantity) || 0;
                        const itemCostProfit = parseFloat(item.costProfit) || 0;
                        return (
                          <TableRow key={item.id} data-testid={`row-detail-${item.id}`} className="text-xs bg-muted/10">
                            <TableCell className="py-1 w-6"></TableCell>
                            <TableCell className="py-1 pl-10 text-muted-foreground">
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-foreground/80">{item.voucherNumber}</span>
                                <span className="text-muted-foreground/60">{item.voucherDate?.slice(0, 10)}</span>
                              </div>
                            </TableCell>
                            {col("qty") && (
                              <TableCell className="text-right font-mono py-1">
                                {formatNumericValue(item.quantity)}
                              </TableCell>
                            )}
                            {col("costPrice") && (
                              <TableCell className="text-right font-mono py-1">
                                {formatAmount(item.costPrice)}
                              </TableCell>
                            )}
                            {col("pricePerBale") && (
                              <TableCell className="text-right font-mono py-1">
                                {formatAmount(item.actualSellingPrice)}
                              </TableCell>
                            )}
                            {col("costProfitBale") && (
                              <TableCell className={`text-right font-mono py-1 ${profitColor(itemCostProfit)}`}>
                                {qty > 0 ? formatAmount(Math.abs(itemCostProfit) / qty) : "—"}
                              </TableCell>
                            )}
                            {col("hassanPrice") && (
                              <TableCell className="text-right font-mono py-1">
                                {formatAmount(item.configuredSellingPrice)}
                              </TableCell>
                            )}
                            {col("hassanProfitBale") && (
                              <TableCell className={`text-right font-mono py-1 ${profitColor(item.configuredProfit)}`}>
                                {qty > 0 ? formatAmount(Math.abs(item.configuredProfit) / qty) : "—"}
                              </TableCell>
                            )}
                            {col("hassanProfitTotal") && (
                              <TableCell className={`text-right font-mono py-1 ${profitColor(item.configuredProfit)}`}>
                                {formatAmount(Math.abs(item.configuredProfit))}
                              </TableCell>
                            )}
                            {col("costProfitTotal") && (
                              <TableCell className={`text-right font-mono py-1 ${profitColor(itemCostProfit)}`}>
                                {formatAmount(Math.abs(itemCostProfit))}
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                  </Fragment>
                );
              })}
          </Fragment>
        );
      })}
    </TableBody>
  );
}
