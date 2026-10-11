import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import type { ItemGroup } from "../types";
import { formatNumericValue, profitColor } from "../utils";

type LocationColor = { dot: string; text: string; badge: string };

interface SalesReportItemMobileViewProps {
  itemGroups: ItemGroup[];
  expandedItems: Set<string>;
  toggleItem: (key: string) => void;
  multipleLocations: boolean;
  locationColorMap: Map<string, LocationColor>;
  formatAmount: (amount: number | string | null | undefined) => string;
  expandedLocations: Set<string>;
  toggleLocation: (key: string) => void;
}

export function SalesReportItemMobileView(props: SalesReportItemMobileViewProps) {
  const {
    itemGroups,
    expandedItems,
    toggleItem,
    multipleLocations,
    locationColorMap,
    formatAmount,
    expandedLocations,
    toggleLocation,
  } = props;
  return (
    <>
      {/* Mobile view — item-grouped cards */}
      <div className="md:hidden space-y-3 p-3">
        {itemGroups.map((group) => {
          const itemKey = String(group.stockItemId);
          const isExpanded = expandedItems.has(itemKey);
          return (
            <div key={itemKey}>
              <Card
                className={`cursor-pointer ${isExpanded ? "rounded-b-none border-b-0" : ""}`}
                onClick={() => toggleItem(itemKey)}
                data-testid={`card-item-${itemKey}`}
              >
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="font-medium text-sm">{group.stockItemName}</span>
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
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <div>
                      <span className="text-muted-foreground">Qty: </span>
                      <span className="font-mono">{formatNumber(group.totalQty)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Sales: </span>
                      <span className="font-mono">{formatAmount(group.totalSales)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Cost: </span>
                      <span className="font-mono">{formatAmount(group.totalCost)}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1 border-t text-xs">
                    <span className={`font-mono font-semibold ${profitColor(group.costProfit)}`}>
                      Cost P/L: {formatAmount(Math.abs(group.costProfit))}
                    </span>
                    <span className={`font-mono font-semibold ${profitColor(group.configuredProfit)}`}>
                      Hassan's P/L: {formatAmount(Math.abs(group.configuredProfit))}
                    </span>
                  </div>
                </CardContent>
              </Card>

              {isExpanded && (
                <div className="border border-t-0 rounded-b-md p-2 space-y-2 bg-background">
                  {group.locationBreakdown.map((loc) => {
                    const locRowKey = `${itemKey}-${loc.locationKey}`;
                    const isLocExpanded = expandedLocations.has(locRowKey);
                    return (
                      <div key={locRowKey}>
                        <Card
                          className={`cursor-pointer ${isLocExpanded ? "rounded-b-none border-b-0" : ""}`}
                          onClick={() => toggleLocation(locRowKey)}
                          data-testid={`card-loc-${locRowKey}`}
                        >
                          <CardContent className="p-2 space-y-1">
                            <div className="flex items-center gap-2">
                              {isLocExpanded ? (
                                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                              {multipleLocations &&
                                (() => {
                                  const color = locationColorMap.get(loc.locationKey);
                                  return color ? (
                                    <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${color.dot}`} />
                                  ) : null;
                                })()}
                              <span
                                className={`text-sm font-medium ${multipleLocations ? (locationColorMap.get(loc.locationKey)?.text ?? "") : ""}`}
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
                            <div className="grid grid-cols-2 gap-1 text-xs pl-5">
                              <div>
                                <span className="text-muted-foreground">Qty: </span>
                                <span className="font-mono">{formatNumber(loc.totalQty)}</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">Sales: </span>
                                <span className="font-mono">{formatAmount(loc.totalSales)}</span>
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-2 pt-1 border-t text-xs pl-5">
                              <span className={`font-mono ${profitColor(loc.costProfit)}`}>
                                Cost: {formatAmount(Math.abs(loc.costProfit))}
                              </span>
                              <span className={`font-mono ${profitColor(loc.configuredProfit)}`}>
                                Hassan's: {formatAmount(Math.abs(loc.configuredProfit))}
                              </span>
                            </div>
                          </CardContent>
                        </Card>

                        {isLocExpanded && (
                          <div className="border border-t-0 rounded-b-md p-2 space-y-1 bg-muted/10">
                            {loc.items.map((item) => (
                              <div key={item.id} className="text-xs p-1 border-b last:border-b-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-foreground/80">{item.voucherNumber}</span>
                                  <span className="text-muted-foreground/60">{item.voucherDate?.slice(0, 10)}</span>
                                </div>
                                <div className="grid grid-cols-2 gap-1 mt-1">
                                  <div>
                                    <span className="text-muted-foreground">Qty: </span>
                                    <span className="font-mono">{formatNumericValue(item.quantity)}</span>
                                  </div>
                                  <div>
                                    <span className="text-muted-foreground">Sales: </span>
                                    <span className="font-mono">{formatAmount(item.totalSales)}</span>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
