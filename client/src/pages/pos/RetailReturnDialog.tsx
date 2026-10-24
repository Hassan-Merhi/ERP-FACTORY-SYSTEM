import { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, RotateCcw, Search, Printer, Minus, Plus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { RetailPhotoGallery } from "@/pages/retail/RetailProductImage";
import { makeKey, money, type RetailSale } from "./retailPosTypes";

type Destination = "original" | "customer_credit";
type ReturnLine = { quantity: number; restock: boolean };

export function RetailReturnDialog({
  open,
  locationId,
  shiftId,
  canOverride = false,
  busy,
  onOpenChange,
  onExchange,
  onPrint,
  onCompleted,
}: {
  open: boolean;
  locationId: number | null;
  shiftId: number | null;
  canOverride?: boolean;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onExchange: (sale: RetailSale) => void;
  onPrint: (sale: RetailSale) => void;
  onCompleted: (sale: RetailSale) => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<RetailSale[]>([]);
  const [searching, setSearching] = useState(false);
  const [sale, setSale] = useState<RetailSale | null>(null);
  const [lines, setLines] = useState<Record<number, ReturnLine>>({});
  const [destination, setDestination] = useState<Destination>("original");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  useEffect(() => {
    if (open) return;
    setTerm("");
    setResults([]);
    setSale(null);
    setLines({});
    setReason("");
    setDestination("original");
    attempt.current = null;
  }, [open]);

  const lookup = async () => {
    if (!locationId) return;
    const query = term.trim();
    if (!query) {
      toast({ title: "Enter a receipt number or item name / barcode", variant: "destructive" });
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({ locationId: String(locationId), limit: "25" });
      if (/^(?:#|R-?)?\d+$/i.test(query)) params.set("receipt", query);
      else params.set("search", query);
      const response = await apiRequest("GET", `/api/pos/retail/sales/search?${params}`);
      let data = (await response.json()) as RetailSale[];
      // Retail barcodes are often all digits. Check a receipt number first,
      // then search the same numeric input as an item barcode if no receipt matched.
      if (!data.length && params.has("receipt") && !query.startsWith("#")) {
        params.delete("receipt");
        params.set("barcode", query);
        const fallback = await apiRequest("GET", `/api/pos/retail/sales/search?${params}`);
        data = (await fallback.json()) as RetailSale[];
      }
      setResults(data);
      setSale(null);
    } catch (error) {
      toast({
        title: "Sale lookup failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setSearching(false);
    }
  };

  const choose = (selected: RetailSale) => {
    setSale(selected);
    setLines({});
    setDestination("original");
    setReason("");
    attempt.current = null;
  };
  const updateLine = (id: number, patch: Partial<ReturnLine>) =>
    setLines((current) => ({ ...current, [id]: { ...(current[id] ?? { quantity: 0, restock: true }), ...patch } }));

  const returned =
    sale?.items.flatMap((line) => {
      const chosen = lines[line.id];
      return chosen?.quantity > 0
        ? [
            {
              saleItemId: line.id,
              quantity: chosen.quantity,
              restock: chosen.restock,
            },
          ]
        : [];
    }) ?? [];

  const estimatedRefund =
    sale?.items.reduce((sum, line) => {
      const quantity = lines[line.id]?.quantity ?? 0;
      return sum + (line.grossUnitPrice ?? line.unitPrice) * quantity;
    }, 0) ?? 0;

  const submit = async () => {
    if (!sale || !locationId || !returned.length) return;
    if (destination === "customer_credit" && !sale.customerId) {
      toast({ title: "Account credit requires a customer on the original sale", variant: "destructive" });
      return;
    }
    if (returned.some((line) => !line.restock) && !reason.trim()) {
      toast({ title: "Explain why damaged or non-sellable items are not restocked", variant: "destructive" });
      return;
    }
    // The same exact retry uses one key; edited lines/options use a fresh key.
    const signature = JSON.stringify({ saleId: sale.id, locationId, returned, destination, reason: reason.trim() });
    if (!attempt.current || attempt.current.signature !== signature) {
      attempt.current = { signature, key: makeKey("retail-return") };
    }
    setSubmitting(true);
    try {
      const response = await apiRequest("POST", `/api/pos/retail/sales/${sale.id}/returns`, {
        locationId,
        shiftId: shiftId ?? undefined,
        idempotencyKey: attempt.current.key,
        items: returned,
        refundDestination: destination,
        notes: reason.trim() || undefined,
      });
      const data = (await response.json()) as { replayed: boolean; refundAmount: number; sale: RetailSale };
      const outcome =
        destination === "customer_credit"
          ? "Credited to customer account"
          : "Reversed / refunded against original tenders";
      toast({
        title: data.replayed ? "Return already recorded" : "Return completed",
        description: `${outcome}: ${money(data.refundAmount)}`,
      });
      attempt.current = null;
      await onCompleted(data.sale);
      onOpenChange(false);
    } catch (error) {
      toast({
        title: "Return failed",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting && !busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[94vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Return or exchange retail items</DialogTitle>
          <DialogDescription>
            Look up the original sale. Only its unreturned items can be refunded, and original prices are preserved.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup();
          }}
        >
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Receipt #, product name, SKU or barcode"
            aria-label="Find original retail sale"
            autoFocus
          />
          <Button type="submit" disabled={searching || !locationId}>
            <Search className="mr-1 h-4 w-4" />
            {searching ? "Finding…" : "Find sale"}
          </Button>
        </form>
        {!sale ? (
          <div className="max-h-[42vh] space-y-2 overflow-auto">
            {results.map((result) => (
              <div key={result.id} className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">
                    Sale #{result.id} · {money(result.totalAmount)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(result.createdAt).toLocaleString()} · {result.customerName || "Walk-in"} · {result.status}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {result.items.map((line) => `${line.name} ${line.color}/${line.size}`).join(", ")}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onPrint(result)}
                  aria-label={`Print sale ${result.id}`}
                >
                  <Printer className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  disabled={
                    result.status !== "completed" || !result.items.some((line) => line.quantity > line.returnedQuantity)
                  }
                  onClick={() => choose(result)}
                >
                  Select
                </Button>
              </div>
            ))}
            {!results.length && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Search a receipt or item to find a transaction.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <strong>Sale #{sale.id}</strong>
                <div className="text-xs text-muted-foreground">{sale.customerName || "Walk-in"}</div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSale(null);
                    setLines({});
                  }}
                >
                  Back to results
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onExchange(sale);
                    onOpenChange(false);
                  }}
                >
                  <ArrowLeftRight className="mr-1 h-4 w-4" /> Exchange
                </Button>
              </div>
            </div>
            <div className="max-h-[38vh] space-y-2 overflow-auto">
              {sale.items.map((line) => {
                const available = Math.max(0, line.quantity - line.returnedQuantity);
                const chosen = lines[line.id] ?? { quantity: 0, restock: true };
                return (
                  <div key={line.id} className="flex flex-wrap items-center gap-3 rounded-md border p-2">
                    <RetailPhotoGallery
                      images={line.imageUrls ?? []}
                      title={`${line.name} · ${line.color}/${line.size}`}
                      imageClassName="h-12 w-12 rounded"
                    />
                    <div className="min-w-[180px] flex-1 text-sm">
                      <strong>{line.name}</strong>
                      <div className="text-xs text-muted-foreground">
                        {line.color} / {line.size} · {line.barcode}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Remaining {available} · Refund / unit {money(line.grossUnitPrice ?? line.unitPrice)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-8 w-8"
                        disabled={chosen.quantity <= 0}
                        onClick={() => updateLine(line.id, { quantity: chosen.quantity - 1 })}
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <span className="w-6 text-center">{chosen.quantity}</span>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-8 w-8"
                        disabled={chosen.quantity >= available}
                        onClick={() => updateLine(line.id, { quantity: chosen.quantity + 1 })}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={chosen.restock}
                        disabled={!canOverride}
                        onChange={(event) => updateLine(line.id, { restock: event.target.checked })}
                      />
                      Restock
                    </label>
                    {chosen.quantity > 0 && !chosen.restock && (
                      <span className="text-xs text-amber-700 dark:text-amber-300">Damaged / not sellable</span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="space-y-1">
              <label htmlFor="retail-refund-destination" className="text-sm font-medium">
                Refund destination
              </label>
              <select
                id="retail-refund-destination"
                value={destination}
                onChange={(event) => setDestination(event.target.value as Destination)}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="original">Original tenders (reverse unpaid credit first)</option>
                <option value="customer_credit" disabled={!sale.customerId || !canOverride}>
                  Customer account credit (manager)
                </option>
              </select>
            </div>
            <Textarea
              placeholder="Return reason / damaged item explanation"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              aria-label="Return reason"
            />
            <div className="flex items-center justify-between border-t pt-3">
              <div className="text-sm">
                Estimated refund <strong>{money(estimatedRefund)}</strong>
                <div className="text-xs text-muted-foreground">
                  Final amount recalculated from original sale by the server
                </div>
              </div>
              <Button type="button" disabled={submitting || !returned.length} onClick={() => void submit()}>
                <RotateCcw className="mr-2 h-4 w-4" />
                {submitting ? "Refunding…" : "Confirm return"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
