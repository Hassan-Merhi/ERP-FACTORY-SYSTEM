import { Home, Package, Snowflake, Sun, TrendingUp, TrendingDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import type { StockGroupSummary } from "./locationInventoryTypes";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";

interface InventoryItem {
  inventoryId: number | null;
  locationId: number;
  stockItemId: number;
  quantity: string;
  averageRate: string | null;
  totalValue: string | null;
  stockItemCode: string;
  stockItemName: string;
  stockItemUom: string;
  stockGroupId: number | null;
  stockGroupName: string | null;
  stockGroupCode: string | null;
  stockItemActive: boolean | null;
  categoryId?: number | null;
  categoryName?: string | null;
}

interface InventoryTableProps {
  filteredStockItems: InventoryItem[];
  showMovement: boolean;
  openingInventoryMap: Map<number, number>;
  selectedRowIndex: number;
  setSelectedRowIndex: (idx: number) => void;
  navigate: (path: string) => void;
  formatAmount: (amt: number) => string;
  canViewCost: boolean;
  itemSearchTerm: string;
  inventory: InventoryItem[];
  selectedGroup: StockGroupSummary | null;
}

export function InventoryTable({
  filteredStockItems,
  showMovement,
  openingInventoryMap,
  selectedRowIndex,
  setSelectedRowIndex,
  navigate,
  formatAmount,
  canViewCost,
  itemSearchTerm,
  inventory,
  selectedGroup,
}: InventoryTableProps) {
  const mobileCards = useMobileCardTable();
  return (
    <Card className="overflow-hidden rounded-2xl border border-violet-200/60 bg-card shadow-sm dark:border-violet-400/20">
      <div className="overflow-x-auto">
        <table {...mobileCards.tableProps} className="w-full border-collapse text-sm sm:min-w-[620px]">
          <thead className="sticky top-0 z-10 bg-violet-50/90 dark:bg-violet-950/40">
            <tr className="h-11 border-b border-violet-200/60 text-muted-foreground dark:border-violet-400/20">
              <th className="text-left px-3 font-medium">Item</th>
              {showMovement ? (
                <>
                  <th className="text-left px-3 font-medium">Category</th>
                  <th className="text-right px-3 font-medium">Opening (BL)</th>
                  <th className="text-right px-3 font-medium">Closing (BL)</th>
                  <th className="text-right px-3 font-medium">Movement</th>
                </>
              ) : (
                <>
                  <th className="text-left px-3 font-medium">Category</th>
                  <th className={`text-right px-3 font-medium ${canViewCost ? "" : "pr-6"}`}>Quantity</th>
                </>
              )}
              {canViewCost && (
                <>
                  <th className="text-right px-3 font-medium">Avg Rate</th>
                  <th className="text-right px-3 pr-6 font-medium">Total Value</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {filteredStockItems.length === 0 ? (
              <tr>
                <td
                  colSpan={canViewCost ? (showMovement ? 7 : 5) : showMovement ? 5 : 3}
                  className="text-center py-8 text-muted-foreground"
                >
                  {itemSearchTerm ? "No items found matching your search" : "No items in this group"}
                </td>
              </tr>
            ) : (
              filteredStockItems.map((item, index) => {
                const closingQty = parseFloat(item.quantity || "0");
                const openingQty = showMovement ? openingInventoryMap.get(item.stockItemId) || 0 : 0;
                const movement = closingQty - openingQty;
                const isNegative = closingQty < 0;
                const isMovementNeg = movement < 0;
                const category = (item.categoryName || "").toLowerCase();
                const isWinter = category.includes("winter");
                const isSummer = category.includes("summer");
                return (
                  <tr
                    key={item.inventoryId ?? `si-${item.stockItemId}`}
                    data-testid={`row-item-desktop-${item.stockItemId}`}
                    className={`h-12 cursor-pointer border-t border-border/60 transition-colors ${
                      index === selectedRowIndex
                        ? isNegative
                          ? "bg-rose-100 ring-1 ring-inset ring-rose-400/50 dark:bg-rose-950/50"
                          : "bg-violet-100/90 ring-1 ring-inset ring-violet-400/50 dark:bg-violet-500/20"
                        : isNegative
                          ? "bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/25 dark:hover:bg-rose-900/30"
                          : "even:bg-violet-50/40 hover:bg-violet-100/70 dark:even:bg-violet-400/[0.035] dark:hover:bg-violet-400/10"
                    }`}
                    onClick={() => setSelectedRowIndex(index)}
                  >
                    <td className="px-3 font-medium min-w-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/locations/${item.locationId}/stock-items/${item.stockItemId}/history`);
                        }}
                        className="text-left text-primary hover:underline cursor-pointer w-full min-w-0"
                        data-testid={`link-item-desktop-${item.stockItemId}`}
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet-200/60 bg-violet-500/10 text-violet-700 dark:border-violet-400/20 dark:bg-violet-400/15 dark:text-violet-200"><Package className="h-4 w-4" aria-hidden="true" /></span>
                           <span className="truncate font-semibold text-foreground hover:text-violet-700 dark:hover:text-violet-300">{item.stockItemName}</span>
                          {/* The code is a column on desktop search; phone cards show it under the name. */}
                          <span className="hidden font-mono text-xs font-normal text-muted-foreground in-data-[mobile-cards=true]:inline">
                            {item.stockItemCode}
                          </span>
                          {item.stockItemActive === false && (
                            <Badge variant="outline" className="text-xs shrink-0">
                              Inactive
                            </Badge>
                          )}
                        </span>
                      </button>
                    </td>
                    <td className="px-3">
                      {item.categoryName ? (
                        <Badge variant="secondary" className={isWinter
                           ? "inline-flex gap-1 rounded-lg border border-violet-200 bg-violet-100/90 px-2 py-1 text-[11px] font-medium text-violet-800 dark:border-violet-400/25 dark:bg-violet-500/20 dark:text-violet-200"
                           : isSummer
                             ? "inline-flex gap-1 rounded-lg border border-amber-200 bg-amber-100/90 px-2 py-1 text-[11px] font-medium text-amber-800 dark:border-amber-400/25 dark:bg-amber-500/20 dark:text-amber-200"
                             : "inline-flex gap-1 rounded-lg border border-blue-200 bg-blue-100/90 px-2 py-1 text-[11px] font-medium text-blue-800 dark:border-blue-400/25 dark:bg-blue-500/20 dark:text-blue-200"}>
                          {isWinter ? <Snowflake className="h-3 w-3" aria-hidden="true" /> : isSummer ? <Sun className="h-3 w-3" aria-hidden="true" /> : <Home className="h-3 w-3" aria-hidden="true" />}
                           {item.categoryName}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    {showMovement ? (
                      <>
                        <td className="px-3 text-right font-mono text-sm text-muted-foreground">
                          {Math.floor(openingQty).toLocaleString()} <span className="text-xs">BL</span>
                        </td>
                        <td className={`px-3 text-right font-mono font-semibold ${isNegative ? "text-red-600" : ""}`}>
                          {Math.floor(closingQty).toLocaleString()}{" "}
                          <span className="text-xs font-normal text-muted-foreground">BL</span>
                        </td>
                        <td
                          className={`px-3 text-right font-mono font-semibold ${isMovementNeg ? "text-red-600" : movement > 0 ? "text-green-600" : "text-muted-foreground"}`}
                        >
                          <span className="inline-flex items-center justify-end gap-1">
                            {movement > 0 ? (
                              <TrendingUp className="h-3.5 w-3.5" />
                            ) : movement < 0 ? (
                              <TrendingDown className="h-3.5 w-3.5" />
                            ) : null}
                            {movement > 0 ? "+" : ""}
                            {Math.floor(movement).toLocaleString()} <span className="text-xs font-normal">BL</span>
                          </span>
                        </td>
                      </>
                    ) : (
                      <td className={`px-3 text-right font-mono font-semibold ${isNegative ? "text-red-600" : ""}`}>
                        <span>
                          {Math.floor(closingQty).toLocaleString()}
                          <span className="ml-2 text-xs font-normal text-muted-foreground">BL</span>
                        </span>
                      </td>
                    )}
                    {canViewCost && (
                      <>
                        <td className="px-3 text-right font-mono text-sm text-muted-foreground">
                          {formatAmount(parseFloat(item.averageRate || "0"))}
                        </td>
                        <td className="px-3 text-right font-mono font-semibold">
                          {formatAmount(closingQty * parseFloat(item.averageRate || "0"))}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
          {filteredStockItems.length > 0 && (
            <tfoot className="border-t-2 border-violet-200/60 bg-violet-50/70 font-semibold dark:border-violet-400/20 dark:bg-violet-950/30">
              <tr className="h-12">
                <td className="px-3 font-bold">Total</td>
                <td className="px-3"></td>
                {showMovement ? (
                  <>
                    <td className="px-3 text-right font-mono font-bold text-muted-foreground">
                      {Math.floor(
                        filteredStockItems.reduce(
                          (sum, item) => sum + (openingInventoryMap.get(item.stockItemId) || 0),
                          0
                        )
                      ).toLocaleString()}{" "}
                      BL
                    </td>
                    <td className="px-3 text-right font-mono font-bold">
                      {Math.floor(
                        filteredStockItems.reduce((sum, item) => sum + parseFloat(item.quantity || "0"), 0)
                      ).toLocaleString()}{" "}
                      BL
                    </td>
                    <td className="px-3 text-right font-mono font-bold">
                      {(() => {
                        const tot = filteredStockItems.reduce(
                          (sum, item) =>
                            sum + parseFloat(item.quantity || "0") - (openingInventoryMap.get(item.stockItemId) || 0),
                          0
                        );
                        return `${tot > 0 ? "+" : ""}${Math.floor(tot).toLocaleString()} BL`;
                      })()}
                    </td>
                  </>
                ) : (
                  <td className="px-3 text-right font-mono font-bold">
                    {Math.floor(
                      filteredStockItems.reduce((sum, item) => sum + parseFloat(item.quantity || "0"), 0)
                    ).toLocaleString()}
                    <span className="ml-3">BL</span>
                  </td>
                )}
                {canViewCost && (
                  <>
                    <td className="px-3"></td>
                    <td className="px-3 text-right font-mono font-bold">
                      {formatAmount(
                        filteredStockItems.reduce(
                          (sum, item) => sum + parseFloat(item.quantity || "0") * parseFloat(item.averageRate || "0"),
                          0
                        )
                      )}
                    </td>
                  </>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {filteredStockItems.length > 0 && selectedGroup && (
        <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
          Showing {filteredStockItems.length} of{" "}
          {inventory.filter((i) => i.stockGroupId === selectedGroup.groupId).length} items
        </div>
      )}
    </Card>
  );
}
