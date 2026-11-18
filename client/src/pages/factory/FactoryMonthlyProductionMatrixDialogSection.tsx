// Extracted from ./FactoryMonthlyProductionMatrix.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useFactoryMonthlyProductionMatrixState } from "./useFactoryMonthlyProductionMatrixState";

export function FactoryMonthlyProductionMatrixDialogSection({
  currentPosition,
  destinationId,
  mhd,
  moveItemId,
  moveMatches,
  moveNextToItem,
  moveRowNumber,
  moveSearch,
  moveToPosition,
  movingProduct,
  orderedProducts,
  parsedMoveRow,
  rowPositionById,
  saving,
  selectedDestination,
  setDestinationId,
  setMoveItemId,
  setMoveRowNumber,
  setMoveSearch,
  t,
  validMoveRow,
}: Pick<
  ReturnType<typeof useFactoryMonthlyProductionMatrixState>,
  | "currentPosition"
  | "destinationId"
  | "mhd"
  | "moveItemId"
  | "moveMatches"
  | "moveNextToItem"
  | "moveRowNumber"
  | "moveSearch"
  | "moveToPosition"
  | "movingProduct"
  | "orderedProducts"
  | "parsedMoveRow"
  | "rowPositionById"
  | "saving"
  | "selectedDestination"
  | "setDestinationId"
  | "setMoveItemId"
  | "setMoveRowNumber"
  | "setMoveSearch"
  | "t"
  | "validMoveRow"
>) {
  return (
    <Dialog
      open={moveItemId !== null}
      onOpenChange={(open) => {
        if (!open && !saving) setMoveItemId(null);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("monthlyProduction.moveTo")}: {movingProduct?.name}
          </DialogTitle>
          <DialogDescription>
            {t("monthlyProduction.currentRow")}: {currentPosition} / {orderedProducts.length}.{" "}
            {t("monthlyProduction.moveHint")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void moveToPosition(1)}>
              {t("monthlyProduction.moveTop")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void moveToPosition(orderedProducts.length)}
            >
              {t("monthlyProduction.moveBottom")}
            </Button>
          </div>
          <div className="space-y-2">
            <label htmlFor="monthly-move-row" className="text-sm font-medium">
              {t("monthlyProduction.rowPosition")} (1–{orderedProducts.length})
            </label>
            <div className="flex gap-2">
              <Input
                id="monthly-move-row"
                type="number"
                inputMode="numeric"
                min={1}
                max={orderedProducts.length}
                step={1}
                value={moveRowNumber}
                onChange={(event) => setMoveRowNumber(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && validMoveRow && !saving) void moveToPosition(parsedMoveRow);
                }}
                aria-invalid={moveRowNumber.trim().length > 0 && !validMoveRow}
                data-testid="monthly-matrix-row-number"
              />
              <Button
                type="button"
                disabled={!validMoveRow || saving}
                onClick={() => void moveToPosition(parsedMoveRow)}
                data-testid="monthly-matrix-move-row"
              >
                {t("monthlyProduction.moveRow")}
              </Button>
            </div>
          </div>
          <div className="border-t pt-3 space-y-2">
            <label htmlFor="monthly-move-search" className="text-sm font-medium">
              {t("monthlyProduction.placeNear")}
            </label>
            <Input
              id="monthly-move-search"
              value={moveSearch}
              onChange={(event) => {
                setMoveSearch(event.target.value);
                setDestinationId(null);
              }}
              placeholder={t("monthlyProduction.searchDestination")}
              data-testid="monthly-matrix-destination-search"
            />
            {moveSearch.trim() && (
              <div
                className="max-h-44 overflow-y-auto rounded-md border"
                role="group"
                aria-label={t("monthlyProduction.placeNear")}
              >
                {moveMatches.length ? (
                  moveMatches.map((product) => (
                    <button
                      key={product.id}
                      type="button"
                      className={
                        "block w-full border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent " +
                        (destinationId === product.id ? "bg-accent font-semibold" : "")
                      }
                      onClick={() => setDestinationId(product.id)}
                      aria-pressed={destinationId === product.id}
                    >
                      <span className="font-medium">{mhd.nameFor(product.articleCode, product.name)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        #{rowPositionById.get(product.id)} · {product.articleCode}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="p-3 text-sm text-muted-foreground">{t("monthlyProduction.noDestination")}</p>
                )}
              </div>
            )}
            {selectedDestination && <p className="text-sm font-medium">{selectedDestination.name}</p>}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={!selectedDestination || saving}
                onClick={() => void moveNextToItem("before")}
              >
                {t("monthlyProduction.placeAbove")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!selectedDestination || saving}
                onClick={() => void moveNextToItem("after")}
              >
                {t("monthlyProduction.placeBelow")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
