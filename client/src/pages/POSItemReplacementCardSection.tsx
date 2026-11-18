// Extracted from ./POSItemReplacement.tsx to keep that module under the source-size cap.
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { displayMoney, displayQty } from "./POSItemReplacementTypes";
import { usePOSItemReplacementState } from "./usePOSItemReplacementState";

export function POSItemReplacementCardSection({
  candidatesLoading,
  locationId,
  replaceQuantities,
  replacementItem,
  replacementLastSoldPrice,
  replacementLastSoldPriceLoading,
  rows,
  selectedReplacements,
  setReplaceQuantities,
  sourceItem,
  updateQty,
}: Pick<
  ReturnType<typeof usePOSItemReplacementState>,
  | "candidatesLoading"
  | "locationId"
  | "replaceQuantities"
  | "replacementItem"
  | "replacementLastSoldPrice"
  | "replacementLastSoldPriceLoading"
  | "rows"
  | "selectedReplacements"
  | "setReplaceQuantities"
  | "sourceItem"
  | "updateQty"
>) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <CardTitle className="text-base">Matching sales</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Enter a replacement quantity only on the POS lines that were wrong. Leave the rest blank.
            </p>
          </div>
          {selectedReplacements.length > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setReplaceQuantities({})}>
              <X className="h-3.5 w-3.5 mr-1.5" />
              Clear quantities
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0 sm:p-6 sm:pt-0">
        {!locationId || !sourceItem ? (
          <div className="py-16 text-center text-sm text-muted-foreground px-4">
            Choose a location and the wrong item to load matching POS sales.
          </div>
        ) : candidatesLoading ? (
          <div className="py-16 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading matching POS sales…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground px-4">
            No matching sales found for this item, location, and date range.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>POS / Voucher</TableHead>
                  <TableHead className="text-right">Sold Qty</TableHead>
                  <TableHead className="text-right">POS Price</TableHead>
                  <TableHead className="text-right">New Item Last Sold</TableHead>
                  <TableHead className="w-[150px] text-right">Replace Qty</TableHead>
                  <TableHead className="text-right">Old Item Left</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const rawReplacement = replaceQuantities[row.saleItemId] ?? "";
                  const replacementQty = Number(rawReplacement || 0);
                  const soldQty = Number(row.quantity);
                  const isInvalid = Number.isFinite(replacementQty) && replacementQty > soldQty;
                  const remaining = Math.max(0, soldQty - (Number.isFinite(replacementQty) ? replacementQty : 0));
                  return (
                    <TableRow key={row.saleItemId} className={replacementQty > 0 ? "bg-muted/40" : undefined}>
                      <TableCell className="whitespace-nowrap text-sm">{row.voucherDate}</TableCell>
                      <TableCell>
                        <div className="font-medium text-sm">{row.voucherNumber}</div>
                        <div className="text-xs text-muted-foreground truncate max-w-[280px]">
                          {row.description || "POS Sale"}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium">{displayQty(row.quantity)}</TableCell>
                      <TableCell className="text-right font-mono">{displayMoney(row.sellingPrice)}</TableCell>
                      <TableCell className="text-right">
                        {!replacementItem ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : replacementLastSoldPriceLoading ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin ml-auto" />
                        ) : replacementLastSoldPrice === null ? (
                          <span className="text-xs text-muted-foreground">No prior sale</span>
                        ) : (
                          <span className="font-mono">{displayMoney(replacementLastSoldPrice)}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Input
                            type="number"
                            min="0"
                            max={row.quantity}
                            step="0.001"
                            inputMode="decimal"
                            value={rawReplacement}
                            onChange={(event) => updateQty(row, event.target.value)}
                            placeholder="0"
                            className={`text-right font-mono ${isInvalid ? "border-destructive focus-visible:ring-destructive" : ""}`}
                            data-testid={`input-pos-replacement-qty-${row.saleItemId}`}
                          />
                          <div className="flex justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => updateQty(row, "1")}
                              disabled={soldQty < 1}
                            >
                              1
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => updateQty(row, row.quantity)}
                            >
                              All
                            </Button>
                          </div>
                          {isInvalid && (
                            <p className="text-[11px] text-destructive text-right">Max {displayQty(row.quantity)}</p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {displayQty(remaining)}
                        {replacementQty > 0 && replacementItem && (
                          <div className="text-[11px] text-muted-foreground mt-1">
                            +{displayQty(replacementQty)} → {replacementItem.name}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
