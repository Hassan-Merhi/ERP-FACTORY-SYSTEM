import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Minus, Plus, ScanLine, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { apiRequest } from "@/lib/queryClient";
import { fetchRetailCartPreview } from "./retailWave2Api";
import { RetailItemImage } from "./RetailScanFeedback";
import { RetailPaymentPanel } from "./RetailPaymentPanel";
import { paymentFromAccount, type RetailPaymentAccounts } from "./RetailPaymentAccountSelect";
import {
  lookupRetailBarcode,
  makeKey,
  money,
  outstandingSaleCredit,
  readJson,
  type RetailPaymentDraft,
  type RetailPosItem,
  type RetailSale,
} from "./retailPosTypes";

interface ExchangeResult {
  replayed: boolean;
  /** Net tender movement at the counter (collected now minus paid back). */
  balanceDue: number;
  receivableReversed?: number;
  tenderRefund?: number;
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
  canOverride = false,
  onOpenChange,
  onCompleted,
}: {
  sale: RetailSale | null;
  locationId: number | null;
  shiftId: number | null;
  canOverride?: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: (sale: RetailSale) => void | Promise<void>;
}) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [returnQty, setReturnQty] = useState<Record<number, number>>({});
  const [noRestock, setNoRestock] = useState<Record<number, boolean>>({});
  const [reason, setReason] = useState("");
  const [newItems, setNewItems] = useState<Array<RetailPosItem & { exchangeQuantity: number }>>([]);
  const [scanText, setScanText] = useState("");
  const [refundAccount, setRefundAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [payments, setPayments] = useState<RetailPaymentDraft[]>([{ method: "cash", amount: 0, tenderedAmount: null }]);
  const { data: accounts } = useQuery<RetailPaymentAccounts>({
    queryKey: ["retail-payment-accounts", selectedCompany?.id],
    queryFn: () => readJson<RetailPaymentAccounts>("/api/pos/retail/payment-accounts"),
    enabled: Boolean(sale),
  });
  const attemptRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    setReturnQty({});
    setNoRestock({});
    setReason("");
    setNewItems([]);
    setScanText("");
    setRefundAccount("");
    setPayments([{ method: "cash", amount: 0, tenderedAmount: null }]);
    attemptRef.current = null;
  }, [sale?.id]);

  const replacementTotal = newItems.reduce((sum, item) => sum + item.exchangeQuantity * item.price, 0);
  // Exact exchange replacement price includes promotions and tax, just like
  // ordinary retail checkout. Never charge the customer's old catalogue price.
  const replacementLines = newItems.map((item) => ({ variantId: item.variantId, quantity: item.exchangeQuantity }));
  const replacementSignature = JSON.stringify({ locationId, replacementLines });
  const previewQuery = useQuery({
    queryKey: ["retail-exchange-preview", replacementSignature],
    queryFn: () => fetchRetailCartPreview(replacementLines, null, locationId ?? undefined),
    enabled: Boolean(sale && locationId && replacementLines.length),
    staleTime: 0,
  });
  const newTotal = previewQuery.data?.pricing.totalAmount ?? replacementTotal;
  useEffect(() => {
    const amount = Number(newTotal.toFixed(2));
    setPayments((current) => {
      if (current.length !== 1) return current;
      const payment = current[0];
      return [
        {
          ...payment,
          amount,
          tenderedAmount: payment.method === "cash" ? Math.max(amount, Number(payment.tenderedAmount ?? 0)) : null,
        },
      ];
    });
  }, [newTotal]);

  if (!sale) return null;

  const refundValue = sale.items.reduce(
    (sum, item) => sum + (returnQty[item.id] ?? 0) * (item.grossUnitPrice ?? item.unitPrice),
    0
  );
  // Mirrors the server: unpaid receivable is reversed first, and only the rest
  // is paid back to the original tenders. A reversal is not cash for the customer.
  const receivableReversed = Math.min(refundValue, outstandingSaleCredit(sale));
  const tenderRefund = Math.max(0, refundValue - receivableReversed);
  const onAccount = payments.reduce(
    (sum, payment) => (payment.method === "credit" ? sum + Number(payment.amount || 0) : sum),
    0
  );
  const collectedNow = payments.reduce(
    (sum, payment) => (payment.method === "credit" ? sum : sum + Number(payment.amount || 0)),
    0
  );
  const balance = (newItems.length ? collectedNow : 0) - tenderRefund;

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
      .map(([saleItemId, quantity]) => ({
        saleItemId: Number(saleItemId),
        quantity,
        restock: !noRestock[Number(saleItemId)],
      }));
    const items = newItems.map((item) => ({ variantId: item.variantId, quantity: item.exchangeQuantity }));
    if (!returnItems.length || !items.length) {
      toast({ title: "Choose what is returned and what the customer takes", variant: "destructive" });
      return;
    }
    if (!previewQuery.data || previewQuery.isFetching) {
      toast({ title: "Replacement price is still loading", variant: "destructive" });
      return;
    }
    if (!accounts || payments.some((payment) => payment.method !== "credit" && !payment.ledgerAccountId && !payment.bankAccountId)) {
      toast({ title: "Select an account for each replacement payment", variant: "destructive" });
      return;
    }
    if (Math.abs(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) - newTotal) > 0.005) {
      toast({ title: "Replacement payments must equal the server-priced replacement total", variant: "destructive" });
      return;
    }
    if (returnItems.some((line) => !line.restock) && !reason.trim()) {
      toast({ title: "Explain why a returned exchange item is not restocked", variant: "destructive" });
      return;
    }
    if (refundAccount && (!canOverride || !accounts)) {
      toast({ title: "A manager must select a valid refund account", variant: "destructive" });
      return;
    }
    const fingerprint = JSON.stringify({ sale: sale.id, shiftId, returnItems, items, payments, refundAccount, reason });
    if (!attemptRef.current || attemptRef.current.fingerprint !== fingerprint) {
      attemptRef.current = { fingerprint, key: makeKey("retail-exchange") };
    }
    setBusy(true);
    try {
      const chosenRefundAccount = refundAccount && accounts ? paymentFromAccount(refundAccount, 1, accounts) : null;
      const response = await apiRequest("POST", "/api/pos/retail/exchanges", {
        idempotencyKey: attemptRef.current.key,
        saleId: sale.id,
        locationId,
        shiftId: shiftId ?? undefined,
        returnItems,
        newItems: items,
        payments,
        refundDestination: refundAccount ? "account" : "original",
        refundLedgerAccountId: chosenRefundAccount?.ledgerAccountId,
        refundBankAccountId: chosenRefundAccount?.bankAccountId,
        notes: reason.trim() || undefined,
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
                      {item.color} · {item.size} · {money(item.grossUnitPrice ?? item.unitPrice)} · {remaining}/
                      {item.quantity}
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
                  {canOverride && (
                    <label className="flex items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={!noRestock[item.id]}
                        onChange={(event) =>
                          setNoRestock((current) => ({ ...current, [item.id]: !event.target.checked }))
                        }
                      />
                      Restock
                    </label>
                  )}
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

          {newItems.length > 0 ? (
            <RetailPaymentPanel
              total={newTotal}
              value={payments}
              onChange={setPayments}
              canUseCredit={Boolean(sale.customerId)}
              accounts={accounts}
              customerName={sale.customerName}
            />
          ) : null}

          {canOverride && tenderRefund > 0.005 && (
            <label className="block space-y-1 text-sm">
              <span>Refund from account</span>
              <select
                className="h-9 w-full rounded-md border bg-background px-2"
                value={refundAccount}
                onChange={(event) => setRefundAccount(event.target.value)}
                aria-label="Exchange refund account"
              >
                <option value="">Original payment accounts</option>
                {accounts?.ledgers.map((entry) => (
                  <option key={`ledger:${entry.id}`} value={`ledger:${entry.id}`}>
                    {entry.code} · {entry.name}
                  </option>
                ))}
                {accounts?.banks.map((entry) => (
                  <option key={`bank:${entry.id}`} value={`bank:${entry.id}`}>
                    {entry.code} · {entry.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Input
            placeholder="Exchange / damaged item reason (optional except for no-restock)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={2000}
          />
          <div className="space-y-1 rounded-md bg-muted/40 p-3 text-sm">
            <div className="flex justify-between">
              <span>Returned value</span>
              <span>-{money(refundValue)}</span>
            </div>
            {receivableReversed > 0.005 && (
              <div
                className="flex justify-between text-xs text-muted-foreground"
                data-testid="exchange-receivable-reversed"
              >
                <span>Reduces unpaid account balance</span>
                <span>-{money(receivableReversed)}</span>
              </div>
            )}
            {receivableReversed > 0.005 && (
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Paid back to original payments</span>
                <span>-{money(tenderRefund)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span>New items (including promotions / tax)</span>
              <span>{money(newTotal)}</span>
            </div>
            {newItems.length > 0 && onAccount > 0.005 && (
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Charged to customer account</span>
                <span>{money(onAccount)}</span>
              </div>
            )}
            {receivableReversed > 0.005 && newItems.length > 0 && onAccount <= 0.005 && sale.customerId && (
              <div className="text-xs text-amber-700 dark:text-amber-300">
                The return reduced the customer's unpaid balance. Use Customer credit below if the customer is not
                paying for the replacement now.
              </div>
            )}
            {previewQuery.isError && (
              <div className="text-xs text-destructive">Could not load replacement pricing.</div>
            )}
            {previewQuery.isFetching && (
              <div className="text-xs text-muted-foreground">Updating replacement pricing…</div>
            )}
            <div className="flex justify-between border-t pt-1 font-semibold">
              <span>{balance >= 0 ? "Customer pays" : "Refund to customer"}</span>
              <span data-testid="exchange-balance">{money(Math.abs(balance))}</span>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy || previewQuery.isFetching || !previewQuery.data}>
              {busy ? "Saving…" : "Complete exchange"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
