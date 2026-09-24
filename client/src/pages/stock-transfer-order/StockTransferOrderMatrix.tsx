import { Fragment } from "react";
import { ChevronDown, ChevronRight, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/formatNumber";
import type { useStockTransferOrderModel } from "./useStockTransferOrderModel";

type Model = ReturnType<typeof useStockTransferOrderModel>;

export function StockTransferOrderMatrix({ model }: { model: Model }) {
  const {
    selectedLocations,
    setLocationDialogOpen,
    isLoading,
    matrixRef,
    handleMatrixKeyDown,
    summaryData,
    toggleGroup,
    expandedGroups,
    sortedGroupItems,
    flatRowIndexById,
    focusedCell,
    setFocusedCell,
    handleCellClick,
  } = model;

  return (
    <Card className="hidden min-w-0 max-w-full lg:block">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            <CardTitle className="text-base">Inventory Matrix</CardTitle>
          </div>
          <p className="text-xs text-muted-foreground">
            Click to focus, then use arrow keys + spacebar to add / Enter to view history
          </p>
        </div>
      </CardHeader>
      <CardContent>
        {selectedLocations.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <MapPin className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>Select source locations to view inventory</p>
            <Button variant="outline" className="mt-4" onClick={() => setLocationDialogOpen(true)}>
              Select Locations
            </Button>
          </div>
        ) : isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((value) => (
              <Skeleton key={value} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <div
            ref={matrixRef}
            tabIndex={0}
            onKeyDown={handleMatrixKeyDown}
            className="max-h-[500px] max-w-full overflow-auto [scrollbar-gutter:stable] focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded-md border"
          >
            <table className="w-full caption-bottom text-sm border-collapse">
              <thead className="[&_tr]:border-b sticky top-0 z-30">
                <tr className="border-b">
                  <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground min-w-[200px] sticky top-0 left-0 bg-muted z-50 border-r shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]">
                    Item
                  </th>
                  {selectedLocations.map((location) => (
                    <th
                      key={location.id}
                      className="h-12 px-4 text-center align-middle font-medium text-muted-foreground min-w-[100px] sticky top-0 bg-muted z-40"
                    >
                      {location.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="[&_tr:last-child]:border-0">
                {summaryData?.stockGroups.map((group) => (
                  <Fragment key={group.id}>
                    <tr
                      className="border-b transition-colors cursor-pointer hover-elevate bg-muted/50"
                      onClick={() => toggleGroup(group.id)}
                      data-testid={`group-row-${group.id}`}
                    >
                      <td className="p-4 align-middle font-medium sticky left-0 bg-muted/50 z-20 border-r shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]">
                        <div className="flex items-center gap-2">
                          {expandedGroups.has(group.id) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          {group.name}
                          <Badge variant="secondary" className="text-xs">
                            {group.items.length}
                          </Badge>
                        </div>
                      </td>
                      {selectedLocations.map((location) => {
                        const quantity = group.locationData[location.id]?.quantity || 0;
                        return (
                          <td key={location.id} className="p-4 align-middle text-center font-mono text-sm">
                            {quantity > 0 ? formatNumber(quantity, 0) : "-"}
                          </td>
                        );
                      })}
                    </tr>

                    {expandedGroups.has(group.id) &&
                      (sortedGroupItems.get(group.id) ?? []).map((item) => {
                        const flatRowIndex = flatRowIndexById.get(item.id) ?? -1;
                        return (
                          <tr
                            key={item.id}
                            data-testid={`item-row-${item.id}`}
                            className="border-b transition-colors hover:bg-muted/50 bg-background"
                          >
                            <td className="p-4 align-middle pl-8 sticky left-0 bg-background z-20 border-r shadow-[2px_0_4px_-2px_rgba(0,0,0,0.1)]">
                              <p className="text-sm">{item.name}</p>
                            </td>
                            {selectedLocations.map((location, colIndex) => {
                              const quantity = item.locationData[location.id]?.quantity || 0;
                              const hasStock = quantity > 0;
                              const isFocused = focusedCell?.row === flatRowIndex && focusedCell?.col === colIndex;
                              return (
                                <td
                                  key={location.id}
                                  className="p-1 align-middle"
                                  data-focused={isFocused ? "true" : undefined}
                                >
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className={cn(
                                      "w-full font-mono",
                                      hasStock && "hover:bg-primary/10 cursor-pointer",
                                      isFocused && "ring-2 ring-primary ring-offset-1"
                                    )}
                                    disabled={!hasStock}
                                    onClick={() => {
                                      setFocusedCell({ row: flatRowIndex, col: colIndex });
                                      handleCellClick(item, location.id, location.name, quantity);
                                    }}
                                    data-testid={`cell-item-${item.id}-loc-${location.id}`}
                                  >
                                    {hasStock ? formatNumber(quantity, 0) : "-"}
                                  </Button>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
