/**
 * Price list body: stats pills, the item table with its inline price editor,
 * and the empty/loading/error states.
 *
 * Split out of POSPriceList.tsx unchanged — cost columns stay behind the same
 * privileged/non-POS gate, All mode still renders one editable column per
 * visible master, and single-location mode keeps the "base" price badge.
 */
import { useState } from "react";
import { AlertCircle, Layers, MapPin } from "lucide-react";
import { useLocation } from "wouter";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { getDefaultPeriodValue } from "@/components/ui/period-filter";
import { StockMovementDialog } from "@/pages/location-inventory/StockMovementDialog";
import { formatQty } from "./utils";
import type {
  StockMovementItem,
  StockMovementMonth,
  StockMovementPeriod,
} from "@/pages/location-inventory/locationInventoryTypes";
import type { PosPriceListModel } from "./usePosPriceListModel";
import { MasterPriceCells, SingleLocationPriceCell, StatsBar, EmptyState } from "./PriceListTableParts";

function ItemsTable({ model }: { model: PosPriceListModel }) {
  const {
    isAllMode,
    showCostPrice,
    canEditPrices: canEdit,
    formatAmount,
    filteredItems,
    locationPricedList,
    masters,
    selectedLocationId,
    selectedLocation,
  } = model;
  const [, navigate] = useLocation();
  const [stockMovementOpen, setStockMovementOpen] = useState(false);
  const [stockMovementItem, setStockMovementItem] = useState<StockMovementItem | null>(null);
  const [stockMovementPeriod, setStockMovementPeriod] = useState<StockMovementPeriod>(() =>
    getDefaultPeriodValue("this_month")
  );
  const [drillMonth, setDrillMonth] = useState<StockMovementMonth | null>(null);

  const openItemHistory = (stockItemId: number, stockItemName: string) => {
    setStockMovementItem({
      stockItemId,
      stockItemName,
      locationId: isAllMode ? null : selectedLocationId,
      locationName: isAllMode ? null : (selectedLocation?.name ?? null),
    });
    setDrillMonth(null);
    setStockMovementOpen(true);
  };

  return (
    <>
      <div className="rounded-xl border max-sm:border-0">
        <Table mobileLayout="cards">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="text-xs">Item Name</TableHead>
              {showCostPrice && (
                <TableHead className="text-xs text-right hidden sm:table-cell w-32">Cost Price</TableHead>
              )}
              {showCostPrice && (
                <TableHead className="text-xs text-right hidden sm:table-cell w-32">Offloading Cost</TableHead>
              )}

              {/* All-mode: one column per visible master */}
              {isAllMode &&
                model.visibleMasters.map((m) => (
                  <TableHead key={m.id} className="text-xs text-right w-40">
                    {m.name}
                  </TableHead>
                ))}

              {isAllMode && <TableHead className="text-xs text-right w-32">Total Qty</TableHead>}

              {/* Actual sales history for the selected location and date range. */}
              {!isAllMode && <TableHead className="text-xs text-right w-32">Highest Price Sold</TableHead>}
              {!isAllMode && <TableHead className="text-xs text-right w-32">Lowest Price Sold</TableHead>}
              {!isAllMode && <TableHead className="text-xs text-right w-28">Qty Sold</TableHead>}

              {/* Single-location mode: one editable Selling Price column */}
              {!isAllMode && <TableHead className="text-xs text-right w-48">Selling Price</TableHead>}

              {!isAllMode && (
                <TableHead className="text-xs text-right hidden sm:table-cell w-28">Qty in Stock</TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredItems.map((item) => (
              <TableRow
                key={item.stockItemId}
                data-testid={`row-price-${item.stockItemId}`}
                className={cn(
                  canEdit && !isAllMode && "group",
                  model.isItemUnpriced(item) && "bg-amber-50/50 dark:bg-amber-950/20"
                )}
              >
                <TableCell data-mobile-cell="title">
                  <button
                    type="button"
                    onClick={() => openItemHistory(item.stockItemId, item.name)}
                    className="font-medium text-left text-primary hover:underline cursor-pointer"
                    data-testid={`link-price-history-${item.stockItemId}`}
                    title="View stock movement history"
                  >
                    {item.name}
                  </button>
                </TableCell>

                {showCostPrice && (
                  <TableCell
                    className="text-right hidden sm:table-cell text-sm tabular-nums text-muted-foreground"
                    data-testid={`text-cost-${item.stockItemId}`}
                  >
                    {item.costPrice && parseFloat(item.costPrice) > 0 ? formatAmount(parseFloat(item.costPrice)) : "—"}
                  </TableCell>
                )}
                {showCostPrice && (
                  <TableCell
                    className="text-right hidden sm:table-cell text-sm tabular-nums text-muted-foreground"
                    data-testid={`text-offloading-cost-${item.stockItemId}`}
                  >
                    {(() => {
                      const total = parseFloat(item.costPrice ?? "0") + parseFloat(item.offloadingCost ?? "0");
                      return total > 0 ? formatAmount(total) : "—";
                    })()}
                  </TableCell>
                )}

                {/* All-mode: editable price per visible master location */}
                {isAllMode && <MasterPriceCells model={model} item={item} />}

                {isAllMode && (
                  <TableCell
                    className="text-right text-sm text-muted-foreground tabular-nums"
                    data-testid={`text-total-qty-${item.stockItemId}`}
                  >
                    {formatQty(item.totalQuantity ?? "0")}
                  </TableCell>
                )}

                {/* Read-only historical prices and quantity, before the current editable price. */}
                {!isAllMode && (
                  <TableCell
                    className="text-right text-sm tabular-nums"
                    data-testid={`text-highest-sold-${item.stockItemId}`}
                  >
                    {item.highestPriceSold == null ? "—" : formatAmount(Number(item.highestPriceSold))}
                  </TableCell>
                )}
                {!isAllMode && (
                  <TableCell
                    className="text-right text-sm tabular-nums"
                    data-testid={`text-lowest-sold-${item.stockItemId}`}
                  >
                    {item.lowestPriceSold == null ? "—" : formatAmount(Number(item.lowestPriceSold))}
                  </TableCell>
                )}
                {!isAllMode && (
                  <TableCell
                    className="text-right text-sm tabular-nums"
                    data-testid={`text-qty-sold-${item.stockItemId}`}
                  >
                    {formatQty(item.qtySold ?? "0")}
                  </TableCell>
                )}

                {/* Single-location mode: editable Selling Price */}
                {!isAllMode && <SingleLocationPriceCell model={model} item={item} />}

                {!isAllMode && (
                  <TableCell
                    className="text-right hidden sm:table-cell text-sm text-muted-foreground tabular-nums"
                    data-testid={`text-qty-${item.stockItemId}`}
                  >
                    {formatQty(item.quantity)}
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground text-right mt-2" data-testid="text-item-count">
        Showing {filteredItems.length} of {locationPricedList.length} items
        {canEdit && (
          <span className="ml-1">
            · Click any price to edit it{isAllMode && masters.length > 0 ? " (cascades to followers)" : ""}
          </span>
        )}
      </p>

      <StockMovementDialog
        stockMovementOpen={stockMovementOpen}
        setStockMovementOpen={setStockMovementOpen}
        stockMovementItem={stockMovementItem}
        setStockMovementItem={setStockMovementItem}
        stockMovementPeriod={stockMovementPeriod}
        setStockMovementPeriod={setStockMovementPeriod}
        drillMonth={drillMonth}
        setDrillMonth={setDrillMonth}
        formatAmount={formatAmount}
        navigate={navigate}
      />
    </>
  );
}

export function PriceListBody({ model }: { model: PosPriceListModel }) {
  const { selectedLocationId, locationsLoading, isError, error, isLoading, isAllMode, masters, filteredItems } = model;
  const noMasters = isAllMode && masters.length === 0;
  return (
    <div className="flex-1 overflow-hidden p-4">
      {!selectedLocationId && !locationsLoading && (
        <div className="flex flex-col items-center justify-center h-full text-center gap-3 text-muted-foreground">
          <MapPin className="w-12 h-12 opacity-25" />
          <div>
            <p className="text-base font-medium">Select a location</p>
            <p className="text-sm mt-1 opacity-70 hidden sm:block">Choose a location from the panel on the left.</p>
            <p className="text-sm mt-1 opacity-70 sm:hidden">Tap a location above to view prices.</p>
          </div>
        </div>
      )}

      {isError && (
        <Alert variant="destructive">
          <AlertCircle className="w-4 h-4" />
          <AlertDescription>{(error as Error)?.message || "Failed to load price list."}</AlertDescription>
        </Alert>
      )}

      {selectedLocationId && isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      )}

      {selectedLocationId && !isLoading && !isError && (
        <>
          {/* No-masters notice in All mode */}
          {noMasters && (
            <Alert>
              <Layers className="w-4 h-4" />
              <AlertDescription>
                No price groups configured. Go to Settings → Price Groups to set up master locations.
              </AlertDescription>
            </Alert>
          )}

          <StatsBar model={model} />

          {filteredItems.length === 0 && !noMasters ? (
            <EmptyState model={model} />
          ) : filteredItems.length > 0 ? (
            <ItemsTable model={model} />
          ) : null}
        </>
      )}
    </div>
  );
}
