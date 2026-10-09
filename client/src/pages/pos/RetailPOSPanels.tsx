import { ArrowRightLeft, Minus, Percent, Plus, Printer, Repeat, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RetailItemImage } from "./RetailScanFeedback";
import { money, type CartLine, type Location, type RetailPosItem, type RetailSale } from "./retailPosTypes";

/** One cart line: exact variant, availability, line adjustment and quantity controls. */
export function RetailCartLineRow({
  line,
  pricedLineTotal,
  onDecrease,
  onIncrease,
  onAdjust,
  onRemove,
}: {
  line: CartLine;
  /** Server-priced line total from the cart preview, when it has loaded. */
  pricedLineTotal: number | null;
  onDecrease: () => void;
  onIncrease: () => void;
  onAdjust: () => void;
  onRemove: () => void;
}) {
  const adjusted = line.priceOverride != null || (line.discountType ?? "none") !== "none";
  const listTotal = line.price * line.cartQuantity;
  return (
    <div className="flex items-center gap-3 rounded-lg border p-3" data-testid="cart-line">
      <RetailItemImage item={line} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" data-no-translate>
          {line.brand} · {line.name}
        </div>
        <div className="text-xs text-muted-foreground" data-no-translate>
          <strong className="text-foreground">{line.color}</strong> ·{" "}
          <strong className="text-foreground">{line.size}</strong> · {line.barcode}
        </div>
        <div className={`text-xs ${line.cartQuantity > line.quantity ? "text-destructive" : "text-muted-foreground"}`}>
          <span data-i18n-ui>Available here</span>: {line.quantity}
        </div>
        {adjusted && (
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400" data-no-translate>
            {line.priceOverride != null
              ? `Override ${money(line.priceOverride)}`
              : line.discountType === "percent"
                ? `-${line.discountValue ?? 0}%`
                : `-${money(line.discountValue ?? 0)} / unit`}
            {line.discountReason ? ` · ${line.discountReason}` : ""}
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Decrease quantity" onClick={onDecrease}>
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <span className="w-8 text-center text-sm font-medium">{line.cartQuantity}</span>
          <Button size="icon" variant="outline" className="h-8 w-8" aria-label="Increase quantity" onClick={onIncrease}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <span className="ml-auto text-sm font-semibold" data-no-translate>
            {adjusted && (
              <span className="mr-1 text-xs font-normal text-muted-foreground line-through">{money(listTotal)}</span>
            )}
            {money(pricedLineTotal ?? listTotal)}
          </span>
          <Button
            size="icon"
            variant={adjusted ? "default" : "outline"}
            className="h-8 w-8"
            aria-label="Line discount or price override"
            onClick={onAdjust}
            data-testid="retail-line-discount"
          >
            <Percent className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Remove from cart" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Summary of the sale just completed, with its tenders and a reprint button. */
export function RetailLastSaleSummary({ sale, onPrint }: { sale: RetailSale; onPrint: () => void }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3 text-sm" data-testid="last-sale">
      <div className="flex items-center justify-between gap-2">
        <strong>Sale #{sale.id}</strong>
        <span>{money(sale.totalAmount)}</span>
      </div>
      <div className="mt-1 space-y-0.5 text-xs text-muted-foreground" data-no-translate>
        {sale.items.map((item) => (
          <div key={item.id}>
            {item.quantity} × {item.name} · {item.color} · {item.size}
          </div>
        ))}
      </div>
      {sale.payments?.length ? (
        <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
          {sale.payments.map((payment) => (
            <div key={payment.id} className="flex justify-between">
              <span>{payment.paymentType === "refund" ? "Refund" : payment.method}</span>
              <span>{money(payment.amount)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onPrint}>
        <Printer className="mr-2 h-4 w-4" /> Print receipt
      </Button>
    </div>
  );
}

/** Recent sales at the location, with per-unit returns, exchange and cancellation. */
export function RetailRecentSalesCard({
  sales,
  isLoading,
  returnPending,
  cancelPending,
  onPrint,
  onReturnOne,
  onExchange,
  onCancel,
}: {
  sales: RetailSale[];
  isLoading: boolean;
  returnPending: boolean;
  cancelPending: boolean;
  onPrint: (sale: RetailSale) => void;
  onReturnOne: (sale: RetailSale, item: RetailSale["items"][number]) => void;
  onExchange: (sale: RetailSale) => void;
  onCancel: (sale: RetailSale) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Recent retail sales & returns</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sales.map((sale) => (
          <div key={sale.id} className="rounded-lg border p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong>Sale #{sale.id}</strong>
                <span className="ml-2 text-xs text-muted-foreground">{new Date(sale.createdAt).toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-semibold">{money(sale.totalAmount)}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{sale.status}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label="Print receipt"
                  onClick={() => onPrint(sale)}
                >
                  <Printer className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              {sale.items.map((item) => {
                const remaining = Math.max(0, item.quantity - item.returnedQuantity);
                return (
                  <div key={item.id} className="flex items-center gap-2 text-sm">
                    <RetailItemImage item={item} className="h-9 w-9" />
                    <span className="min-w-0 flex-1 truncate" data-no-translate>
                      {item.name} · {item.color} · {item.size}{" "}
                      <span className="text-muted-foreground">× {item.quantity}</span>
                    </span>
                    {item.returnedQuantity > 0 && (
                      <span className="text-xs text-muted-foreground">Returned {item.returnedQuantity}</span>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={sale.status !== "completed" || remaining < 1 || returnPending}
                      onClick={() => onReturnOne(sale, item)}
                    >
                      <RotateCcw className="mr-1 h-3.5 w-3.5" />
                      Return 1
                    </Button>
                  </div>
                );
              })}
            </div>
            {sale.status === "completed" && (
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="outline" onClick={() => onExchange(sale)}>
                  <Repeat className="mr-1 h-3.5 w-3.5" /> Exchange
                </Button>
                <Button size="sm" variant="ghost" disabled={cancelPending} onClick={() => onCancel(sale)}>
                  Cancel / reverse sale
                </Button>
              </div>
            )}
          </div>
        ))}
        {!isLoading && !sales.length && (
          <div className="text-sm text-muted-foreground">No retail sales at this location yet.</div>
        )}
      </CardContent>
    </Card>
  );
}

/** Back-office transfer of one exact variant to another location. */
export function RetailVariantTransferCard({
  items,
  destinations,
  variantId,
  toLocationId,
  quantity,
  pending,
  onVariantChange,
  onDestinationChange,
  onQuantityChange,
  onSubmit,
}: {
  items: RetailPosItem[];
  destinations: Location[];
  variantId: number | "";
  toLocationId: number | "";
  quantity: number;
  pending: boolean;
  onVariantChange: (value: number | "") => void;
  onDestinationChange: (value: number | "") => void;
  onQuantityChange: (value: number) => void;
  onSubmit: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ArrowRightLeft className="h-5 w-5" /> Exact-variant transfer
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>Variant (Color · Size)</Label>
          <select
            value={variantId}
            onChange={(event) => onVariantChange(event.target.value ? Number(event.target.value) : "")}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">Choose exact product + color + size</option>
            {items.map((item) => (
              <option key={item.variantId} value={item.variantId}>
                {item.name} · {item.brand} · {item.color} · {item.size} · Qty {item.quantity}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Destination</Label>
          <select
            value={toLocationId}
            onChange={(event) => onDestinationChange(event.target.value ? Number(event.target.value) : "")}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="">Choose destination</option>
            {destinations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor="retail-transfer-qty">Quantity</Label>
          <Input
            id="retail-transfer-qty"
            type="number"
            min="0.000001"
            step="1"
            value={quantity}
            onChange={(event) => onQuantityChange(Number(event.target.value))}
          />
        </div>
        <Button
          variant="outline"
          className="w-full"
          disabled={pending || !variantId || !toLocationId}
          onClick={onSubmit}
        >
          {pending ? "Transferring…" : "Transfer exact variant"}
        </Button>
      </CardContent>
    </Card>
  );
}
