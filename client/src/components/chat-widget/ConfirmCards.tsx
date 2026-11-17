import { useState } from "react";
import { Package, Loader2, Check, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StockItemDraft, PriceUpdateDraft } from "./chatWidgetTypes";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";
export { StockAdjustmentConfirmCard, VoucherSearchResultsCard } from "./StockAdjustmentConfirmCard";

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
              <Select
                value={String(groupId ?? "") || "__none__"}
                onValueChange={(value) => handleGroupChange(value === "__none__" ? "" : value)}
              >
                <SelectTrigger
                  className="h-8 w-full text-sm"
                  data-testid="select-stock-item-group"
                  aria-label="Stock Group"
                >
                  <SelectValue placeholder="— Select group —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Select group —</SelectItem>
                  {draft.groupCandidates.map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            <Select value={String(itemId)} onValueChange={handleItemChange}>
              <SelectTrigger className="h-8 w-full text-sm" data-testid="select-price-item" aria-label="Stock Item">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {draft.itemCandidates.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name} ({c.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
              <Select
                value={String(locationId ?? "") || "__none__"}
                onValueChange={(value) => handleLocationChange(value === "__none__" ? "" : value)}
              >
                <SelectTrigger
                  className="h-8 w-full text-sm"
                  data-testid="select-price-location"
                  aria-label="Price Group / Location"
                >
                  <SelectValue placeholder="— Select —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Select —</SelectItem>
                  {draft.allLocations.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
