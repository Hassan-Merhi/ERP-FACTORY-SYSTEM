// Extracted from ./OpeningStockDetail.tsx
import { Skeleton } from "@/components/ui/skeleton";
import { DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "./OpeningStockDetailHelpers";
import { useOpeningStockDetailState } from "./useOpeningStockDetailState";

export function OpeningStockDetailDialogContent({
  debugData,
  debugLoading,
  formatAmount,
  selectedItem,
}: Pick<
  ReturnType<typeof useOpeningStockDetailState>,
  "debugData" | "debugLoading" | "formatAmount" | "selectedItem"
>) {
  return (
    <DialogContent className="max-w-3xl max-h-[80vh] overflow-auto">
      <DialogHeader>
        <DialogTitle>Inventory Details: {selectedItem?.name || "Loading..."}</DialogTitle>
      </DialogHeader>

      {debugLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : debugData ? (
        <div className="space-y-4">
          {/* Stock Item Info */}
          <div className="bg-muted/50 p-4 rounded-lg">
            <h3 className="font-semibold mb-2">Stock Item Master Data</h3>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                Code: <span className="font-mono">{debugData.stockItem.code}</span>
              </div>
              <div>Name: {debugData.stockItem.name}</div>
              <div>
                Opening Qty: <span className="font-mono">{debugData.stockItem.openingQty}</span>
              </div>
              <div>
                Opening Rate: <span className="font-mono">{debugData.stockItem.openingRate}</span>
              </div>
              <div>
                Opening Value: <span className="font-mono">{debugData.stockItem.openingValue}</span>
              </div>
            </div>
          </div>

          {/* Inventory Records */}
          <div>
            <h3 className="font-semibold mb-2">
              Inventory Records ({debugData.totals.activeRecordCount} active / {debugData.totals.recordCount} total)
            </h3>
            {debugData.inventoryRecords.length > 0 ? (
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Avg Rate</TableHead>
                    <TableHead className="text-right">Total Value</TableHead>
                    <TableHead>Last Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {debugData.inventoryRecords.map((rec) => (
                    <TableRow key={rec.id} className={rec.locationDeleted ? "opacity-50 line-through" : ""}>
                      <TableCell className="font-mono">{rec.id}</TableCell>
                      <TableCell>{rec.locationName}</TableCell>
                      <TableCell>
                        {rec.locationStatus === "Active" ? (
                          <span className="text-green-600 dark:text-green-400">Active</span>
                        ) : rec.locationStatus === "INACTIVE" ? (
                          <span className="text-yellow-600 dark:text-yellow-400 font-semibold">INACTIVE</span>
                        ) : (
                          <span className="text-destructive font-semibold">DELETED</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(rec.quantity, 0)}</TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(rec.averageRate)}</TableCell>
                      <TableCell className="text-right font-mono">{formatAmount(rec.totalValue)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(rec.lastUpdated).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground text-center py-4">No inventory records found for this item.</p>
            )}
          </div>

          {/* Active Totals (what shows in closing balance) */}
          <div className="bg-green-500/10 p-4 rounded-lg border border-green-500/30">
            <h3 className="font-semibold mb-2 text-green-600 dark:text-green-400">
              Active Locations Only (Closing Balance in Report)
            </h3>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold font-mono text-green-600 dark:text-green-400">
                  {formatNumber(debugData.totals.activeQuantity)}
                </div>
                <div className="text-sm text-muted-foreground">Quantity</div>
              </div>
              <div>
                <div className="text-2xl font-bold font-mono text-green-600 dark:text-green-400">
                  {debugData.totals.activeQuantity > 0
                    ? formatNumber(debugData.totals.activeValue / debugData.totals.activeQuantity)
                    : "0.00"}
                </div>
                <div className="text-sm text-muted-foreground">Avg Rate</div>
              </div>
              <div>
                <div className="text-2xl font-bold font-mono text-green-600 dark:text-green-400">
                  {formatAmount(debugData.totals.activeValue)}
                </div>
                <div className="text-sm text-muted-foreground">Value</div>
              </div>
            </div>
          </div>

          {/* All Records Totals (for reference) */}
          {debugData.totals.recordCount > debugData.totals.activeRecordCount && (
            <div className="bg-muted/30 p-4 rounded-lg border border-muted">
              <h3 className="font-semibold mb-2 text-muted-foreground">
                All Records Including Deleted Locations (Old Incorrect Total)
              </h3>
              <div className="grid grid-cols-3 gap-4 text-center text-muted-foreground">
                <div>
                  <div className="text-xl font-mono">{formatNumber(debugData.totals.totalQuantity)}</div>
                  <div className="text-sm">Quantity</div>
                </div>
                <div>
                  <div className="text-xl font-mono">{formatNumber(debugData.totals.calculatedRate)}</div>
                  <div className="text-sm">Avg Rate</div>
                </div>
                <div>
                  <div className="text-xl font-mono">{formatAmount(debugData.totals.totalValue)}</div>
                  <div className="text-sm">Value</div>
                </div>
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            The closing balance now only counts inventory from active locations. Records from deleted locations are
            shown crossed out above for reference.
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground text-center py-8">Unable to load inventory details.</p>
      )}
    </DialogContent>
  );
}
