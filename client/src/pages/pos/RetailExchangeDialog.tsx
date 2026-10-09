import { useEffect, useRef, useState } from "react";
import { Minus, Plus, ScanLine, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { RetailItemImage } from "./RetailScanFeedback";
import { RetailPaymentPanel } from "./RetailPaymentPanel";
import {
  lookupRetailBarcode,
  makeKey,
  money,
  type RetailPaymentDraft,
  type RetailPosItem,
  type RetailSale,
} from "./retailPosTypes";

interface ExchangeResult {
  replayed: boolean;
  balanceDue: number;
  refundValue: number;
  newSaleTotal: number;
  sale: RetailSale;
}

/**
 * Exchange = return items from the original sale + sell the replacement items,
 * in one server transaction. The original sale keeps its return record and the
 * replacement is a new sale, so both sides stay traceable.
 */
export function RetailExchangeDialog({
  sale,
  locationId,
  shiftId,
  onOpenChange,
  onCompleted,
}: {
  sale: RetailSale | null;
  locationId: number | null;
  shiftId: number | null;
  onOpenChange: (open: boolean) => void;
  onCompleted: (sale: RetailSale) => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [returnQty, setReturnQty] = useState<Record<number, number>>({});
  const [newItems, setNewItems] = useState<Array<RetailPosItem & { exchangeQuantity: number }>>([]);
  const [scanText, setScanText] = useState("");
  const [busy, setBusy] = useState(false);
  const [payments, setPayments] = useState<RetailPaymentDraft[]>([{ method: "cash", amount: 0, tenderedAmount: 0 }]);
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    setReturnQty({});
    setNewItems([]);
    setScanText("");
    setPayments([{ method: "cash", amount: 0, tenderedAmount: 0 }]);
    attemptRef.current = null;
  }, [sale?.id]);

  const replacementTotal = newItems.reduce((sum, item) => sum + item.exchangeQuantity * item.price, 0);
  useEffect(() => {
    const amount = Number(replacementTotal.toFixed(2));
    setPayments([{ method: "cash", amount, tenderedAmount: amount }]);
  }, [replacementTotal]);

  if (!sale) return null;

  const refundValue = sale.items.reduce((sum, item) => sum + (returnQty[item.id] ?? 0) * item.unitPrice, 0);
  const newTotal = replacementTotal;
  const balance = newTotal - refundValue;

  const scan = async () => {
    const barcode = scanText.trim();
    if (!barcode || !locationId) return;
    try {
      const result = await lookupRetailBarcode(barcode, locationId);
      if (result.kind === "unknown") throw new Error(`Unknown barcode ${barcode}`);
      if (result.kind === "inactive") throw new Error("This item is archived and cannot be sold");
      const item = result.item;
      setNewItems((current) => {
        const existing = current.find((entry) => entry.variantId === item.variantId);
        if (existing) {
          return current.map((entry) =>
            entry.variantId === item.variantId ? { ...entry, exchangeQuantity: entry.exchangeQuantity + 1 } : entry
          );
        }
        return [...current, { ...item, exchangeQuantity: 1 }];
      });
      setScanText("");
    } catch (error) {
      toast({
        title: "Barcode not found",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  };

  const submit = async () => {
    if (!locationId) return;
    const returnItems = Object.entries(returnQty)
      .filter(([, quantity]) => quantity > 0)
      .map(([saleItemId, quantity]) => ({ saleItemId: Number(saleItemId), quantity }));
    const items = newItems.map((item) => ({ variantId: item.variantId, quantity: item.exchangeQuantity }));
    if (!returnItems.length || !items.length) {
      toast({ title: "Choose what is returned and what the customer takes", variant: "destructive" });
      return;
    }
    const fingerprint = JSON.stringify({ sale: sale.id, shiftId, returnItems, items, payments });
    if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
      attemptRef.current = { fingerprint, key: makeKey("retail-exchange") };
    }
    setBusy(true);
    try {
      const response = await apiRequest("POST", "/api/pos/retail/exchanges", {
        idempotencyKey: attemptRef.current.key,
        saleId: sale.id,
        locationId,
        shiftId: shiftId ?? undefined,
        returnItems,
        newItems: items,
        payments,
      });
      const result = (await response.json()) as ExchangeResult;
      attemptRef.current = null;
      toast({
        title: result.replayed ? "Exchange already recorded" : "Exchange completed",
        description:
          result.balanceDue > 0
            ? `Customer pays: ${money(result.balanceDue)}`
            : result.balanceDue < 0
              ? `Refund ${money(-result.balanceDue)}`
              : "Even exchange",
      });
      await onCompleted(result.sale);
    } catch (error) {
      toast({
        title: "Exchange failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(sale)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Exchange · Sale #{sale.id}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Customer returns</h3>
            {sale.items.map((item) => {
              const remaining = Math.max(0, item.quantity - item.returnedQuantity);
              const value = returnQty[item.id] ?? 0;
              return (
                <div key={item.id} className="flex items-center gap-3 rounded-md border p-2">
                  <RetailItemImage item={item} className="h-10 w-10" />
                  <div className="min-w-0 flex-1 text-sm" data-no-translate>
                    <div className="truncate font-medium">{item.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {item.color} · {item.size} · {money(item.unitPrice)} · {remaining}/{item.quantity}
                    </div>
                  </div>
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-8 w-8"
                    aria-label="Decrease"
                    disabled={value <= 0}
                    onClick={() => setReturnQty((current) => ({ ...current, [item.id]: Math.max(0, value - 1) }))}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <span className="w-6 text-center text-sm font-semibold">{value}</span>
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-8 w-8"
                    aria-label="Increase"
                    disabled={value >= remaining}
                    onClick={() =>
                      setReturnQty((current) => ({ ...current, [item.id]: Math.min(remaining, value + 1) }))
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Customer takes</h3>
            <form
              className="relative"
              onSubmit={(event) => {
                event.preventDefault();
                void scan();
              }}
            >
              <ScanLine className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                className="pl-9"
                placeholder="Scan the replacement item"
                value={scanText}
                onChange={(event) => setScanText(event.target.value)}
              />
            </form>
            {newItems.map((item) => (
              <div key={item.variantId} className="flex items-center gap-3 rounded-md border p-2">
                <RetailItemImage item={item} className="h-10 w-10" />
                <div className="min-w-0 flex-1 text-sm" data-no-translate>
                  <div className="truncate font-medium">{item.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.color} · {item.size} · {money(item.price)} · Qty {item.quantity}
                  </div>
                </div>
                <span className="w-6 text-center text-sm font-semibold">{item.exchangeQuantity}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  aria-label="Remove"
                  onClick={() =>
                    setNewItems((current) => current.filter((entry) => entry.variantId !== item.variantId))
                  }
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </section>

          {newItems.length > 0 ? <RetailPaymentPanel total={newTotal} value={payments} onChange={setPayments} /> : null}

          <div className="space-y-1 rounded-md bg-muted/40 p-3 text-sm">
            <div className="flex justify-between">
              <span>Returned value</span>
              <span>-{money(refundValue)}</span>
            </div>
            <div className="flex justify-between">
              <span>New items</span>
              <span>{money(newTotal)}</span>
            </div>
            <div className="flex justify-between border-t pt-1 font-semibold">
              <span>{balance >= 0 ? "Customer pays" : "Refund to customer"}</span>
              <span data-testid="exchange-balance">{money(Math.abs(balance))}</span>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? "Saving…" : "Complete exchange"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
