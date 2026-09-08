import { TrendingUp, TrendingDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

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
  posUser?: any;
  itemSearchTerm: string;
  inventory: InventoryItem[];
  selectedGroup: any;
}

export function InventoryTable({
  filteredStockItems,
  showMovement,
  openingInventoryMap,
  selectedRowIndex,
  setSelectedRowIndex,
  navigate,
  formatAmount,
  posUser,
  itemSearchTerm,
  inventory,
  selectedGroup,
}: InventoryTableProps) {
  // The server is authoritative: unauthorized POS responses have cost fields
  // nulled. If cost is present, this POS user has the explicit per-company
  // inventory.cost.view permission.
  const canViewCost = !posUser || inventory.some((item) => item.averageRate !== null && item.averageRate !== undefined);

  return (
    <Card className="border-none shadow-none bg-transparent">
      <div>
        <table className="w-full text-sm border-collapse">
          <thead className="sticky top-0 z-10 bg-background">
            <tr className="bg-muted/50 text-muted-foreground h-10">
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
                return (
                  <tr
                    key={item.inventoryId ?? `si-${item.stockItemId}`}
                    data-testid={`row-item-desktop-${item.stockItemId}`}
                    className={`border-t h-12 ${
                      index === selectedRowIndex
                        ? isNegative
                          ? "bg-red-200 dark:bg-red-800/50 ring-2 ring-primary"
                          : "bg-accent"
                        : isNegative
                          ? "bg-rose-50 dark:bg-rose-950/30"
                          : "hover-elevate"
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
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="truncate">{item.stockItemName}</span>
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
                        <Badge variant="secondary" className="text-xs font-normal">
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
                        {Math.floor(closingQty).toLocaleString()}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">BL</span>
                      </td>
                    )}
                    {canViewCost && (
                      <>
                        <td className="px-3 text-right font-mono text-sm text-muted-foreground">
                          {formatAmount(parseFloat(item.averageRate || "0"))}
                        </td>
                        <td className="px-3 text-right font-mono font-semibold">
                          {formatAmount(parseFloat(item.totalValue || "0"))}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
          {filteredStockItems.length > 0 && (
            <tfoot className="bg-muted/50 border-t-2 font-semibold">
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
                        filteredStockItems.reduce((sum, item) => sum + parseFloat(item.totalValue || "0"), 0)
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
        <div className="mt-4 text-sm text-muted-foreground">
          Showing {filteredStockItems.length} of{" "}
          {inventory.filter((i) => i.stockGroupId === selectedGroup.groupId).length} items
        </div>
      )}
    </Card>
  );
}