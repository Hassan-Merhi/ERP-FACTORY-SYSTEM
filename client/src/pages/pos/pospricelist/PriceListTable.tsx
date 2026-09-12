/**
 * Price list body: stats pills, the item table with its inline price editor,
 * and the empty/loading/error states.
 *
 * Split out of POSPriceList.tsx unchanged — cost columns stay behind the same
 * privileged/non-POS gate, All mode still renders one editable column per
 * visible master, and single-location mode keeps the "base" price badge.
 */
import { AlertCircle, Check, EyeOff, Layers, MapPin, Pencil, Tag, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatQty } from "./utils";
import type { PriceListRow } from "./types";
import type { PosPriceListModel } from "./usePosPriceListModel";

/**
 * The editor is only mounted for the cell that `editingItem` points at, so the
 * mutation's pending flag alone reproduces the original per-cell isSaving.
 */
function PriceEditor({
  model,
  testIdSuffix,
  width,
}: {
  model: PosPriceListModel;
  testIdSuffix: string;
  width: string;
}) {
  const isSaving = model.updatePriceMutation.isPending;
  return (
    <div className="flex items-center justify-end gap-1">
      <Input
        ref={model.inputRef}
        data-testid={`input-price-${testIdSuffix}`}
        type="number"
        step="0.01"
        className={cn(width, "h-8 text-right tabular-nums")}
        defaultValue={model.editingItem!.value}
        onChange={(e) => {
          // Keep the browser in charge of the draft value while typing. Updating
          // `editingItem` state on every keystroke retriggers the model's focus/
          // select effect, which selects the entire field and makes each next
          // digit replace the previous one. The editor owns this object for the
          // lifetime of the active cell, so mutating its draft value keeps save,
          // blur, and keyboard navigation reading the latest value without a
          // rerender/select cycle.
          model.editingItem!.value = e.target.value;
        }}
        onKeyDown={model.handleKeyDown}
        onBlur={model.handleBlur}
        disabled={isSaving}
      />
      <Button
        size="icon"
        variant="ghost"
        onClick={model.commitEdit}
        disabled={isSaving}
        data-testid={`button-save-price-${testIdSuffix}`}
      >
        <Check className="w-3.5 h-3.5 text-green-600" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        onClick={model.cancelEdit}
        disabled={isSaving}
        data-testid={`button-cancel-price-${testIdSuffix}`}
      >
        <X className="w-3.5 h-3.5 text-muted-foreground" />
      </Button>
    </div>
  );
}

function MasterPriceCells({ model, item }: { model: PosPriceListModel; item: PriceListRow }) {
  const { canEdit, editingItem, formatAmount } = model;
  return (
    <>
      {model.visibleMasters.map((m) => {
        const price = model.masterPriceFor(item, m.id);
        const isEditing = editingItem?.stockItemId === item.stockItemId && editingItem?.locationId === m.id;
        return (
          <TableCell key={m.id} className="text-right">
            {isEditing ? (
              <PriceEditor model={model} testIdSuffix={`${item.stockItemId}-${m.id}`} width="w-24" />
            ) : (
              <div
                className={cn(
                  "flex items-center justify-end gap-1.5 group/cell",
                  canEdit && "cursor-pointer rounded-md px-2 py-1 hover-elevate"
                )}
                onClick={() => canEdit && model.startEdit(item.stockItemId, m.id, price)}
                title={canEdit ? `Click to edit ${m.name} price` : undefined}
                data-testid={`cell-price-${item.stockItemId}-${m.id}`}
              >
                <span className="font-semibold tabular-nums">
                  {price && parseFloat(price) > 0 ? formatAmount(parseFloat(price)) : "—"}
                </span>
                {canEdit && (
                  <Pencil className="w-3 h-3 text-muted-foreground opacity-40 md:opacity-0 md:group-hover/cell:opacity-60 transition-opacity shrink-0" />
                )}
              </div>
            )}
          </TableCell>
        );
      })}
    </>
  );
}

function SingleLocationPriceCell({ model, item }: { model: PosPriceListModel; item: PriceListRow }) {
  const { canEdit, editingItem, formatAmount, selectedLocationId } = model;
  const isEditing = editingItem?.stockItemId === item.stockItemId;
  return (
    <TableCell className="text-right">
      {isEditing ? (
        <PriceEditor model={model} testIdSuffix={`${item.stockItemId}`} width="w-28" />
      ) : (
        <div
          className={cn(
            "flex items-center justify-end gap-1.5",
            canEdit && "group cursor-pointer rounded-md px-2 py-1 hover-elevate"
          )}
          data-testid={`cell-price-${item.stockItemId}`}
          onClick={() => canEdit && model.startEdit(item.stockItemId, selectedLocationId!, item.sellingPrice ?? null)}
          title={canEdit ? "Click to edit price" : undefined}
        >
          <span className="font-semibold tabular-nums">
            {item.sellingPrice ? formatAmount(parseFloat(item.sellingPrice)) : "—"}
          </span>
          {!item.hasCustomPrice && item.sellingPrice && (
            <Badge variant="secondary" className="text-xs hidden sm:inline-flex">
              base
            </Badge>
          )}
          {canEdit && (
            <Pencil className="w-3 h-3 text-muted-foreground opacity-40 md:opacity-0 md:group-hover:opacity-60 transition-opacity shrink-0" />
          )}
        </div>
      )}
    </TableCell>
  );
}

function StatsBar({ model }: { model: PosPriceListModel }) {
  const { locationPricedList, unpricedCount } = model;
  if (locationPricedList.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3 mb-4">
      <div className="rounded-lg border bg-muted/40 px-4 py-2 flex items-center gap-3">
        <Tag className="w-4 h-4 text-muted-foreground shrink-0" />
        <div>
          <p className="text-xs text-muted-foreground leading-none mb-0.5">Total Items</p>
          <p className="text-base font-semibold leading-none">{locationPricedList.length}</p>
        </div>
      </div>
      <div className="rounded-lg border bg-muted/40 px-4 py-2 flex items-center gap-3">
        <Check className="w-4 h-4 text-muted-foreground shrink-0" />
        <div>
          <p className="text-xs text-muted-foreground leading-none mb-0.5">Priced</p>
          <p className="text-base font-semibold leading-none">{locationPricedList.length - unpricedCount}</p>
        </div>
      </div>
      {unpricedCount > 0 && (
        <div className="rounded-lg border bg-amber-500/10 border-amber-500/30 px-4 py-2 flex items-center gap-3">
          <EyeOff className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <div>
            <p className="text-xs text-amber-700 dark:text-amber-400 leading-none mb-0.5">Unpriced</p>
            <p className="text-base font-semibold leading-none text-amber-700 dark:text-amber-400">{unpricedCount}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ model }: { model: PosPriceListModel }) {
  const { showUnpriced, search, hiddenUnpricedGroups, unpricedByGroup, groupFilter } = model;
  const message =
    showUnpriced && !search && hiddenUnpricedGroups.size === unpricedByGroup.length
      ? "All groups hidden — click a group chip above to show items."
      : showUnpriced && !search
        ? "All items are priced."
        : search || groupFilter !== "all" || showUnpriced
          ? "No items match your filters."
          : "No items found.";
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-2 text-muted-foreground py-16">
      <Tag className="w-10 h-10 opacity-30" />
      <p className="text-sm">{message}</p>
      {(search || groupFilter !== "all" || showUnpriced) && (
        <Button variant="ghost" size="sm" onClick={model.clearFilters}>
          Clear filters
        </Button>
      )}
    </div>
  );
}

function ItemsTable({ model }: { model: PosPriceListModel }) {
  const { isAllMode, showCostPrice, canEdit, formatAmount, filteredItems, locationPricedList, masters } = model;
  return (
    <>
      <div className="rounded-xl border">
        <Table wrapperClassName="max-h-[calc(100vh-320px)] sm:max-h-[calc(100vh-280px)]">
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-28 text-xs">Code</TableHead>
              <TableHead className="text-xs">Item Name</TableHead>
              <TableHead className="text-xs hidden sm:table-cell">Group</TableHead>
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

              {/* Single-location mode: one Selling Price column */}
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
                <TableCell className="font-mono text-sm text-muted-foreground">{item.code || "—"}</TableCell>
                <TableCell>
                  <div className="font-medium">{item.name}</div>
                  {item.stockGroupName && (
                    <div className="text-xs text-muted-foreground sm:hidden">{item.stockGroupName}</div>
                  )}
                </TableCell>
                <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                  {item.stockGroupName || "—"}
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
