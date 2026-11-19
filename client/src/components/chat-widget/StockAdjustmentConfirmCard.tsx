// Extracted from ./ConfirmCards.tsx to keep that module under the source-size cap.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import { Check, Loader2, Package, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StockAdjustmentDraft } from "./chatWidgetTypes";
export { VoucherSearchResultsCard } from "./VoucherSearchResultsCard";

// ── Stock Adjustment Confirmation Card ───────────────────────────────
export function StockAdjustmentConfirmCard({
  draft,
  onConfirm,
  onDismiss,
  isSubmitting,
}: {
  draft: StockAdjustmentDraft;
  onConfirm: (resolved: StockAdjustmentDraft) => void;
  onDismiss: () => void;
  isSubmitting: boolean;
}) {
  const [selectedItems, setSelectedItems] = useState<{ id: number; name: string }[]>(() =>
    draft.items.map((i) => ({ id: i.stockItemId, name: i.stockItemName }))
  );
  const [selectedLocationId, setSelectedLocationId] = useState(draft.locationId);
  const [selectedLocationName, setSelectedLocationName] = useState(draft.locationName);

  const produces = draft.items.filter((i) => i.type === "PRODUCE");
  const consumes = draft.items.filter((i) => i.type === "CONSUME");
  const adjType =
    produces.length > 0 && consumes.length > 0 ? "Mixed" : produces.length > 0 ? "Production" : "Consumption";

  const locCandidates = draft.locationCandidates ?? [];
  const hasLocChoice = locCandidates.length > 1;

  const handleConfirm = () => {
    const resolved: StockAdjustmentDraft = {
      ...draft,
      locationId: selectedLocationId,
      locationName: selectedLocationName,
      items: draft.items.map((item, i) => ({
        ...item,
        stockItemId: selectedItems[i].id,
        stockItemName: selectedItems[i].name,
      })),
    };
    onConfirm(resolved);
  };

  return (
    <div
      className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 overflow-hidden"
      data-testid="stock-adj-confirm-card"
    >
      <div className="px-3 py-2 bg-amber-500/10 flex items-center gap-2">
        <Package className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
        <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">Create {adjType} Voucher?</span>
      </div>
      <div className="px-3 py-2 space-y-2 text-xs">
        <div className="flex justify-between gap-2 text-muted-foreground items-center">
          <span className="shrink-0">Date</span>
          <span className="font-medium text-foreground">{draft.date}</span>
        </div>

        {/* Location — dropdown if multiple candidates */}
        <div className="flex justify-between gap-2 text-muted-foreground items-center">
          <span className="shrink-0">Location</span>
          {hasLocChoice ? (
            <Select
              value={String(selectedLocationId)}
              onValueChange={(value) => {
                const id = Number(value);
                const loc = locCandidates.find((l) => l.id === id);
                if (loc) {
                  setSelectedLocationId(id);
                  setSelectedLocationName(loc.name);
                }
              }}
            >
              <SelectTrigger
                className="h-7 max-w-[180px] px-1.5 text-xs font-medium text-foreground"
                aria-label="Location"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {locCandidates.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="font-medium text-foreground">{selectedLocationName}</span>
          )}
        </div>

        {draft.notes && (
          <div className="flex justify-between gap-2 text-muted-foreground">
            <span>Notes</span>
            <span className="font-medium text-foreground truncate max-w-[180px]">{draft.notes}</span>
          </div>
        )}
        {draft.optional && (
          <div className="flex justify-between gap-2 text-muted-foreground">
            <span>Status</span>
            <span className="font-medium text-amber-600 dark:text-amber-400">Optional</span>
          </div>
        )}

        {/* Items table */}
        <div className="border-t pt-1.5 mt-0.5 space-y-1.5">
          {(() => {
            const hasStockPreview = draft.items.some((i) => i.currentStock !== undefined);
            const cols = hasStockPreview ? "grid-cols-[1fr_42px_32px_48px_70px]" : "grid-cols-[1fr_50px_36px_48px]";
            return (
              <>
                <div
                  className={`grid ${cols} gap-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide`}
                >
                  <span>Item</span>
                  <span className="text-center">Type</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Rate</span>
                  {hasStockPreview && <span className="text-right">Stock</span>}
                </div>
                <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                  {draft.items.map((item, i) => {
                    const candidates = item.candidates ?? [];
                    const hasChoice = candidates.length > 1;
                    const isNegative = item.projectedStock !== undefined && item.projectedStock < 0;
                    return (
                      <div key={i} className={`grid ${cols} gap-1 items-center`}>
                        {hasChoice ? (
                          <Select
                            value={String(selectedItems[i].id)}
                            onValueChange={(value) => {
                              const id = Number(value);
                              const c = candidates.find((c) => c.id === id);
                              if (c) {
                                setSelectedItems((prev) =>
                                  prev.map((s, idx) => (idx === i ? { id: c.id, name: c.name } : s))
                                );
                              }
                            }}
                          >
                            <SelectTrigger
                              className="h-7 w-full px-1.5 text-xs font-medium text-foreground"
                              aria-label="Item"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {candidates.map((c) => (
                                <SelectItem key={c.id} value={String(c.id)}>
                                  {c.name}
                                  {c.code ? ` (${c.code})` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="truncate text-foreground">{selectedItems[i].name}</span>
                        )}
                        <span
                          className={`text-center text-[11px] font-semibold ${item.type === "PRODUCE" ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
                        >
                          {item.type === "PRODUCE" ? "Produce" : "Consume"}
                        </span>
                        <span className="text-right text-foreground">{item.quantity.toLocaleString()}</span>
                        <span className="text-right text-muted-foreground">
                          {item.rate > 0 ? (
                            item.rate.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          ) : (
                            <span className="italic text-[11px]">—</span>
                          )}
                        </span>
                        {hasStockPreview && (
                          <span
                            className={`text-right text-[11px] ${isNegative ? "text-destructive font-semibold" : "text-muted-foreground"}`}
                          >
                            {item.currentStock !== undefined ? `${item.currentStock}→` : ""}
                            {item.projectedStock !== undefined ? (
                              <span className={isNegative ? "text-destructive" : "text-green-600 dark:text-green-400"}>
                                {item.projectedStock}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}
        </div>
        {draft.items.some((i) => i.projectedStock !== undefined && i.projectedStock < 0) && (
          <p className="text-[11px] text-destructive border-t pt-1">
            Warning: stock would go negative for one or more items.
          </p>
        )}
      </div>
      <div className="px-3 py-2 border-t flex gap-2 justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={onDismiss}
          disabled={isSubmitting}
          data-testid="button-dismiss-stock-adj"
        >
          <XCircle className="h-3.5 w-3.5 mr-1" /> Dismiss
        </Button>
        <Button size="sm" onClick={handleConfirm} disabled={isSubmitting} data-testid="button-confirm-stock-adj">
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5 mr-1" />
          )}
          Confirm & Create
        </Button>
      </div>
    </div>
  );
}
