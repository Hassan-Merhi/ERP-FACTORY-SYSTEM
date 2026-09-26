import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { InventoryItem } from "./posTypes";

export interface PosItemRateInfo {
  displayRate: number;
  normalDisplayRate: number;
  lastSoldDisplayRate: number | null;
}

interface PosMobileItemSheetProps {
  item: InventoryItem | null;
  onOpenChange: (open: boolean) => void;
  /** Default price and reference prices, from the same resolver the grid uses. */
  rateInfo: PosItemRateInfo | null;
  formatDisplayAmount: (value: number) => string;
  /** Adds the line through the POS selection logic with the chosen quantity and price. */
  onAdd: (item: InventoryItem, quantity: number, rate: number) => void;
  /** Where focus goes when the sheet closes (the product search). */
  returnFocusRef: React.RefObject<HTMLInputElement | null>;
}

const inputClassName =
  "h-12 w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base font-semibold tabular-nums outline-none focus:ring-2 focus:ring-ring";

/**
 * Phone POS item sheet: tapping a search result opens this bottom sheet to set quantity and
 * price before the line enters the cart. Add Item hands the values to the existing POS selection
 * logic (stock rules, row placement, currency conversion); nothing is posted until checkout.
 */
export function PosMobileItemSheet({
  item,
  onOpenChange,
  rateInfo,
  formatDisplayAmount,
  onAdd,
  returnFocusRef,
}: PosMobileItemSheetProps) {
  return (
    <Sheet open={item !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="mx-auto flex max-h-[min(90dvh,40rem)] !flex-nowrap flex-col gap-0 rounded-t-2xl p-0 sm:max-w-lg"
        data-testid="sheet-pos-mobile-item"
        // Portalled: the interface translator only localises marked portals.
        data-i18n-portal=""
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef.current?.focus();
        }}
      >
        {item && (
          // Keyed by item: each opened item starts from quantity 1 and its default price.
          <PosItemForm
            key={item.stockItemId ?? item.code}
            item={item}
            rateInfo={rateInfo}
            formatDisplayAmount={formatDisplayAmount}
            onAdd={onAdd}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function PosItemForm({
  item,
  rateInfo,
  formatDisplayAmount,
  onAdd,
  onCancel,
}: {
  item: InventoryItem;
  rateInfo: PosItemRateInfo | null;
  formatDisplayAmount: (value: number) => string;
  onAdd: (item: InventoryItem, quantity: number, rate: number) => void;
  onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState("1");
  const [rate, setRate] = useState(() => (rateInfo ? String(rateInfo.displayRate) : ""));

  const quantityValue = Number.parseFloat(quantity);
  const rateValue = Number.parseFloat(rate);
  const validQuantity = Number.isFinite(quantityValue) && quantityValue > 0;
  const validRate = Number.isFinite(rateValue) && rateValue >= 0;
  const total = validQuantity && validRate ? quantityValue * rateValue : 0;

  const stepQuantity = (delta: number) => {
    const current = Number.isFinite(quantityValue) ? quantityValue : 0;
    setQuantity(String(Math.max(1, current + delta)));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!validQuantity || !validRate) return;
    onAdd(item, quantityValue, rateValue);
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col" noValidate>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pb-4 pt-5">
        <div className="pe-10">
          <SheetTitle className="break-words text-lg leading-snug">{item.name}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{item.code}</SheetDescription>
        </div>

        <dl className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border px-2 py-2">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground" data-i18n-ui="">
              In stock
            </dt>
            <dd
              className={`mt-0.5 font-semibold tabular-nums ${item.stock <= 0 ? "text-red-600" : ""}`}
              data-testid="text-pos-sheet-stock"
            >
              {Math.round(item.stock).toLocaleString()}
            </dd>
          </div>
          <div className="rounded-lg border px-2 py-2">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground" data-i18n-ui="">
              Price
            </dt>
            <dd className="mt-0.5 truncate font-semibold tabular-nums" dir="ltr">
              {rateInfo ? formatDisplayAmount(rateInfo.normalDisplayRate) : "—"}
            </dd>
          </div>
          <div className="rounded-lg border px-2 py-2">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground" data-i18n-ui="">
              Last sold
            </dt>
            <dd className="mt-0.5 truncate font-semibold tabular-nums" dir="ltr">
              {rateInfo?.lastSoldDisplayRate != null ? formatDisplayAmount(rateInfo.lastSoldDisplayRate) : "—"}
            </dd>
          </div>
        </dl>

        <div className="space-y-1.5">
          <Label htmlFor="pos-sheet-quantity">Quantity</Label>
          <div className="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-12 w-12 p-0"
              onClick={() => stepQuantity(-1)}
              disabled={!validQuantity || quantityValue <= 1}
              aria-label="Decrease quantity"
              data-testid="button-pos-sheet-qty-minus"
            >
              <Minus className="h-4 w-4" />
            </Button>
            <input
              id="pos-sheet-quantity"
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              onFocus={(event) => event.target.select()}
              className={`${inputClassName} text-center`}
              data-testid="input-pos-sheet-quantity"
            />
            <Button
              type="button"
              variant="outline"
              className="h-12 w-12 p-0"
              onClick={() => stepQuantity(1)}
              aria-label="Increase quantity"
              data-testid="button-pos-sheet-qty-plus"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pos-sheet-rate">Selling price</Label>
          <input
            id="pos-sheet-rate"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={rate}
            onChange={(event) => setRate(event.target.value)}
            onFocus={(event) => event.target.select()}
            enterKeyHint="done"
            className={`${inputClassName} text-right font-mono`}
            data-testid="input-pos-sheet-rate"
          />
        </div>

        <div className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {validQuantity ? quantityValue.toLocaleString() : 0} × {validRate ? formatDisplayAmount(rateValue) : "—"}
          </span>
          <span className="font-mono text-lg font-bold tabular-nums" dir="ltr" data-testid="text-pos-sheet-total">
            {formatDisplayAmount(total)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 border-t px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <Button
          type="button"
          variant="outline"
          className="min-h-12"
          onClick={onCancel}
          data-testid="button-pos-sheet-cancel"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          className="min-h-12"
          disabled={!validQuantity || !validRate}
          data-testid="button-pos-sheet-add"
        >
          Add Item
        </Button>
      </div>
    </form>
  );
}
