import { useState } from "react";
import { useLocation } from "wouter";
import { Package, XCircle, Loader2, Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StockAdjustmentDraft, VoucherSearchResult, StockItemDraft, PriceUpdateDraft } from "./chatWidgetTypes";

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
            <select
              className="text-xs font-medium text-foreground bg-background border rounded-sm px-1.5 py-0.5 max-w-[180px]"
              value={selectedLocationId}
              onChange={(e) => {
                const id = Number(e.target.value);
                const loc = locCandidates.find((l) => l.id === id);
                if (loc) {
                  setSelectedLocationId(id);
                  setSelectedLocationName(loc.name);
                }
              }}
            >
              {locCandidates.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
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
                  className={`grid ${cols} gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide`}
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
                          <select
                            className="text-xs font-medium text-foreground bg-background border rounded-sm px-1.5 py-0.5 w-full"
                            value={selectedItems[i].id}
                            onChange={(e) => {
                              const id = Number(e.target.value);
                              const c = candidates.find((c) => c.id === id);
                              if (c) {
                                setSelectedItems((prev) =>
                                  prev.map((s, idx) => (idx === i ? { id: c.id, name: c.name } : s))
                                );
                              }
                            }}
                          >
                            {candidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                                {c.code ? ` (${c.code})` : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="truncate text-foreground">{selectedItems[i].name}</span>
                        )}
                        <span
                          className={`text-center text-[10px] font-semibold ${item.type === "PRODUCE" ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
                        >
                          {item.type === "PRODUCE" ? "Produce" : "Consume"}
                        </span>
                        <span className="text-right text-foreground">{item.quantity.toLocaleString()}</span>
                        <span className="text-right text-muted-foreground">
                          {item.rate > 0 ? (
                            item.rate.toLocaleString(undefined, { maximumFractionDigits: 2 })
                          ) : (
                            <span className="italic text-[10px]">—</span>
                          )}
                        </span>
                        {hasStockPreview && (
                          <span
                            className={`text-right text-[10px] ${isNegative ? "text-destructive font-semibold" : "text-muted-foreground"}`}
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
          <p className="text-[10px] text-destructive border-t pt-1">
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

// ── Voucher Search Results Card ──────────────────────────────────────
const VOUCHER_TYPE_TAB: Record<string, string> = {
  Payment: "payment",
  Receipt: "receipt",
  Journal: "journal",
  "Stock Transfer": "transfer",
  Production: "adjustment",
  Consumption: "adjustment",
  Mixed: "adjustment",
  "Credit Note": "creditnote",
};

export function VoucherSearchResultsCard({
  results,
  onDismiss,
}: {
  results: VoucherSearchResult[];
  onDismiss: () => void;
}) {
  const [, setLocation] = useLocation();
  return (
    <div
      className="mt-2 rounded-md border border-blue-500/30 bg-blue-500/5 overflow-hidden"
      data-testid="voucher-search-results-card"
    >
      <div className="px-3 py-2 bg-blue-500/10 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
          <span className="text-sm font-semibold text-blue-700 dark:text-blue-400">
            {results.length} Voucher{results.length !== 1 ? "s" : ""} Found
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onDismiss}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      <div className="divide-y">
        {results.map((v) => {
          const tab = VOUCHER_TYPE_TAB[v.voucherType] ?? "payment";
          const amount = parseFloat(v.totalAmount).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
          return (
            <div key={v.id} className="px-3 py-2 flex items-start justify-between gap-2 hover-elevate">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-semibold text-foreground">{v.voucherNumber}</span>
                  <span className="text-[10px] text-muted-foreground bg-muted rounded-sm px-1 py-0.5">
                    {v.voucherType}
                  </span>
                  {v.optional && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-sm px-1 py-0.5">
                      Optional
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{v.description || "—"}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">{v.voucherDate}</span>
                  <span className="text-[10px] font-medium text-foreground">${amount}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 text-xs h-7 px-2"
                onClick={() => setLocation(`/vouchers?tab=${tab}`)}
                data-testid={`button-view-voucher-${v.id}`}
              >
                View
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Stock Item Confirmation Card ────────────────────────────────────
export function StockItemConfirmCard({
  draft,
  onConfirm,
  onDismiss,
  isSubmitting,
}: {
  draft: StockItemDraft;
  onConfirm: (resolved: StockItemDraft) => void;
  onDismiss: () => void;
  isSubmitting: boolean;
}) {
  const [name, setName] = useState(draft.name);
  const [code, setCode] = useState(draft.code);
  const [uom, setUom] = useState(draft.uom);
  const [groupId, setGroupId] = useState<number | null>(draft.stockGroupId);
  const [groupName, setGroupName] = useState(draft.stockGroupName);

  const handleGroupChange = (val: string) => {
    const id = parseInt(val, 10);
    const found = draft.groupCandidates.find((g) => g.id === id);
    setGroupId(id);
    setGroupName(found?.name ?? "");
  };

  const handleConfirm = () => {
    onConfirm({ ...draft, name, code, uom, stockGroupId: groupId, stockGroupName: groupName });
  };

  return (
    <div
      className="mt-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 overflow-hidden"
      data-testid="stock-item-confirm-card"
    >
      <div className="px-3 py-2 bg-emerald-500/10 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Package className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Create Stock Item?</span>
        </div>
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onDismiss} disabled={isSubmitting}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      <div className="px-3 py-3 space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">Item Name</label>
            <input
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="input-stock-item-name"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">Code</label>
            <input
              className="w-full rounded-md border bg-background px-2 py-1 text-sm uppercase"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              data-testid="input-stock-item-code"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">UOM</label>
            <input
              className="w-full rounded-md border bg-background px-2 py-1 text-sm uppercase"
              value={uom}
              onChange={(e) => setUom(e.target.value.toUpperCase())}
              data-testid="input-stock-item-uom"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">Stock Group</label>
            {draft.groupCandidates.length > 0 ? (
              <select
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                value={groupId ?? ""}
                onChange={(e) => handleGroupChange(e.target.value)}
                data-testid="select-stock-item-group"
              >
                <option value="">— Select group —</option>
                {draft.groupCandidates.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                value={groupName}
                readOnly
                data-testid="input-stock-item-group"
              />
            )}
          </div>
        </div>
        {!groupId && (
          <p className="text-xs text-amber-600 dark:text-amber-400">A stock group is required to create the item.</p>
        )}
      </div>
      <div className="px-3 pb-3 flex items-center gap-2 justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={onDismiss}
          disabled={isSubmitting}
          data-testid="button-cancel-stock-item"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleConfirm}
          disabled={isSubmitting || !name.trim() || !code.trim() || !uom.trim() || !groupId}
          data-testid="button-confirm-stock-item"
        >
          {isSubmitting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
          Create Item
        </Button>
      </div>
    </div>
  );
}

// ── Price Update Confirmation Card ──────────────────────────────────
export function PriceUpdateConfirmCard({
  draft,
  onConfirm,
  onDismiss,
  isSubmitting,
}: {
  draft: PriceUpdateDraft;
  onConfirm: (resolved: PriceUpdateDraft) => void;
  onDismiss: () => void;
  isSubmitting: boolean;
}) {
  const [itemId, setItemId] = useState(draft.stockItemId);
  const [itemName, setItemName] = useState(draft.stockItemName);
  const [itemCode, setItemCode] = useState(draft.stockItemCode);
  const [locationId, setLocationId] = useState<number | null>(draft.locationId);
  const [locationName, setLocationName] = useState(draft.locationName);
  const [price, setPrice] = useState(String(draft.newPrice));

  const handleItemChange = (val: string) => {
    const id = parseInt(val, 10);
    const found = draft.itemCandidates.find((c) => c.id === id);
    setItemId(id);
    setItemName(found?.name ?? "");
    setItemCode(found?.code ?? "");
  };

  const handleLocationChange = (val: string) => {
    const id = parseInt(val, 10);
    const found = draft.allLocations.find((l) => l.id === id);
    setLocationId(id);
    setLocationName(found?.name ?? "");
  };

  const priceNum = parseFloat(price);
  const valid = itemId > 0 && locationId && !isNaN(priceNum) && priceNum > 0;

  return (
    <div
      className="mt-2 rounded-md border border-violet-500/30 bg-violet-500/5 overflow-hidden"
      data-testid="price-update-confirm-card"
    >
      <div className="px-3 py-2 bg-violet-500/10 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-violet-600 dark:text-violet-400 shrink-0" />
          <span className="text-sm font-semibold text-violet-700 dark:text-violet-400">Update Price List?</span>
        </div>
        <Button variant="ghost" size="icon" className="h-5 w-5" onClick={onDismiss} disabled={isSubmitting}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      <div className="px-3 py-3 space-y-2 text-sm">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground font-medium">Stock Item</label>
          {draft.itemCandidates.length > 1 ? (
            <select
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={itemId}
              onChange={(e) => handleItemChange(e.target.value)}
              data-testid="select-price-item"
            >
              {draft.itemCandidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm font-medium">
              {itemName} <span className="text-xs text-muted-foreground">({itemCode})</span>
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">Price Group / Location</label>
            {draft.allLocations.length > 0 ? (
              <select
                className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                value={locationId ?? ""}
                onChange={(e) => handleLocationChange(e.target.value)}
                data-testid="select-price-location"
              >
                <option value="">— Select —</option>
                {draft.allLocations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-sm font-medium">{locationName || "—"}</p>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground font-medium">New Price</label>
            <input
              type="number"
              min="0"
              step="0.01"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              data-testid="input-new-price"
            />
          </div>
        </div>
        {locationId && draft.followerCount > 0 && (
          <p className="text-xs text-violet-600 dark:text-violet-400">
            This price group has {draft.followerCount} follower location{draft.followerCount !== 1 ? "s" : ""} — price
            will cascade to all of them automatically.
          </p>
        )}
      </div>
      <div className="px-3 pb-3 flex items-center gap-2 justify-end">
        <Button
          size="sm"
          variant="outline"
          onClick={onDismiss}
          disabled={isSubmitting}
          data-testid="button-cancel-price-update"
        >
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() =>
            onConfirm({
              ...draft,
              stockItemId: itemId,
              stockItemName: itemName,
              stockItemCode: itemCode,
              locationId,
              locationName,
              newPrice: priceNum,
            })
          }
          disabled={isSubmitting || !valid}
          data-testid="button-confirm-price-update"
        >
          {isSubmitting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
          Update Price
        </Button>
      </div>
    </div>
  );
}
