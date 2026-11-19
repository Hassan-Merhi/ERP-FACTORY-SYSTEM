import { useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { planRetailReceiptLabelJob, type RetailSupplierReceiptLabelItem } from "./retailSupplierReceiptLabels";
import {
  RETAIL_LABEL_LAYOUTS,
  LAYOUT_STORAGE_KEY,
  PRICE_STORAGE_KEY,
  readPreference,
  writePreference,
  useRetailLabelPrinter,
  type RetailLabelLayout,
  type RetailLabelData,
  type RetailLabelRequestItem,
} from "./retailLabelsParts";
export {
  RETAIL_LABEL_LAYOUTS,
  loadBarcodeSvg,
  RetailLabelSheet,
  useRetailLabelPrinter,
  type RetailLabelLayout,
  type RetailLabelData,
  type RetailLabelRequestItem,
} from "./retailLabelsParts";

export function RetailLabelPrintDialog({
  open,
  onOpenChange,
  items,
  currency,
  purpose = "standard",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: RetailLabelRequestItem[];
  currency?: string | null;
  purpose?: "standard" | "supplier-receipt";
}) {
  const { toast } = useToast();
  const { print, portal, printing } = useRetailLabelPrinter();
  const receiptMode = purpose === "supplier-receipt";
  const [layout, setLayout] = useState<RetailLabelLayout>(
    () => readPreference(LAYOUT_STORAGE_KEY, "thermal-50x30") as RetailLabelLayout
  );
  const [showPrice, setShowPrice] = useState(() => readPreference(PRICE_STORAGE_KEY, "true") === "true");
  const [copies, setCopies] = useState<Record<number, number>>({});
  const [remaining, setRemaining] = useState<Record<number, number>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (receiptMode) {
      setRemaining(Object.fromEntries(items.map((item) => [item.variantId, item.receivedQuantity ?? 0])));
      setSelected(new Set(items.map((item) => item.variantId)));
    } else {
      setCopies(Object.fromEntries(items.map((item) => [item.variantId, 1])));
    }
  }, [open, items, receiptMode]);

  const receiptJob = receiptMode
    ? planRetailReceiptLabelJob(items as RetailSupplierReceiptLabelItem[], remaining, selected)
    : [];
  const receiptPending = receiptMode ? items.reduce((sum, item) => sum + (remaining[item.variantId] ?? 0), 0) : 0;
  const selectedPending = receiptMode
    ? items.reduce((sum, item) => sum + (selected.has(item.variantId) ? (remaining[item.variantId] ?? 0) : 0), 0)
    : 0;
  const totalLabels = receiptMode
    ? receiptJob.reduce((sum, item) => sum + item.copies, 0)
    : items.reduce((sum, item) => sum + (copies[item.variantId] ?? 1), 0);

  const submit = async () => {
    if (busy || printing) return;
    setBusy(true);
    try {
      writePreference(LAYOUT_STORAGE_KEY, layout);
      writePreference(PRICE_STORAGE_KEY, String(showPrice));
      const requestedItems = receiptMode
        ? receiptJob
        : items.map((item) => ({ variantId: item.variantId, copies: Math.max(1, copies[item.variantId] ?? 1) }));
      if (!requestedItems.length) throw new Error("Select one or more variants with labels remaining");
      const response = await apiRequest("POST", "/api/retail/labels", {
        layout,
        items: requestedItems,
      });
      const body = (await response.json()) as { labels: RetailLabelData[] };
      await print(body.labels, layout, showPrice, currency);
      if (receiptMode) {
        // Tracks prepared print jobs only: the browser cannot reliably tell
        // whether the printer completed each job or the user cancelled it.
        setRemaining((current) => {
          const next = { ...current };
          for (const item of requestedItems) {
            next[item.variantId] = Math.max(0, (next[item.variantId] ?? 0) - item.copies);
          }
          return next;
        });
      } else {
        onOpenChange(false);
      }
    } catch (error) {
      toast({
        title: "Could not print labels",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {portal}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{receiptMode ? "Print received stock labels" : "Print barcode labels"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Label layout</Label>
              <div className="grid gap-2">
                {RETAIL_LABEL_LAYOUTS.map((option) => (
                  <label
                    key={option.id}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${layout === option.id ? "border-primary bg-primary/5" : ""}`}
                  >
                    <input
                      type="radio"
                      name="retail-label-layout"
                      className="mt-1"
                      checked={layout === option.id}
                      onChange={() => setLayout(option.id)}
                    />
                    <span>
                      <span className="block text-sm font-medium">{option.title}</span>
                      <span className="block text-xs text-muted-foreground">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={showPrice} onCheckedChange={(value) => setShowPrice(value === true)} />
              <span>Show selling price on label</span>
            </label>

            {receiptMode && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">
                  {receiptPending === 0
                    ? "All receipt label batches prepared"
                    : `${receiptPending.toLocaleString()} received-unit labels remaining`}
                </p>
                <p className="text-xs text-muted-foreground">
                  Each job prepares up to 500 labels from this receipt's purchased quantities, never from lifetime
                  stock. Continue printing batches until complete, or skip printing without affecting the recorded
                  purchase.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setSelected(
                        new Set(
                          items.filter((item) => (remaining[item.variantId] ?? 0) > 0).map((item) => item.variantId)
                        )
                      )
                    }
                  >
                    Select all remaining
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                    Clear selection
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>{receiptMode ? "Received quantity per variant" : "Copies"}</Label>
                {!receiptMode && items.some((item) => (item.stockQuantity ?? 0) > 0) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setCopies(
                        Object.fromEntries(
                          items.map((item) => [item.variantId, Math.max(1, Math.round(item.stockQuantity ?? 1))])
                        )
                      )
                    }
                  >
                    One per unit in stock
                  </Button>
                )}
              </div>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {items.map((item) => (
                  <div key={item.variantId} className="flex items-center gap-3 rounded-md border p-2">
                    {receiptMode && (
                      <Checkbox
                        aria-label={`Include ${item.title}`}
                        checked={selected.has(item.variantId)}
                        disabled={(remaining[item.variantId] ?? 0) === 0 || busy || printing}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked === true) next.add(item.variantId);
                            else next.delete(item.variantId);
                            return next;
                          })
                        }
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium" data-no-translate>
                        {item.title}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{item.barcode}</div>
                      {receiptMode && (
                        <div className="text-xs text-muted-foreground">
                          Received: {item.receivedQuantity ?? 0} · Unprepared: {remaining[item.variantId] ?? 0}
                        </div>
                      )}
                    </div>
                    {receiptMode ? (
                      <div className="w-20 text-right text-sm tabular-nums">
                        {receiptJob.find((entry) => entry.variantId === item.variantId)?.copies ?? 0}
                        <span className="block text-xs text-muted-foreground">this batch</span>
                      </div>
                    ) : (
                      <Input
                        type="number"
                        min={1}
                        max={500}
                        className="w-20"
                        aria-label="Copies"
                        value={copies[item.variantId] ?? 1}
                        onChange={(event) =>
                          setCopies((current) => ({
                            ...current,
                            [item.variantId]: Math.min(500, Math.max(1, Number(event.target.value) || 1)),
                          }))
                        }
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            <p className="text-xs text-muted-foreground" data-i18n-ui>
              {receiptMode
                ? "Prints only the stored barcode and optional selling price. Supplier purchase cost is never printed. Browser print cancellation cannot be detected; reopen this receipt to prepare reprints if needed."
                : "Reprinting uses the same barcode. Labels scan straight into the Retail POS."}
            </p>
            <div className="flex justify-end gap-2 border-t pt-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {receiptMode ? "Done / skip printing" : "Cancel"}
              </Button>
              <Button
                type="button"
                onClick={() => void submit()}
                disabled={busy || printing || !items.length || (receiptMode && !selectedPending)}
              >
                <Printer className="mr-2 h-4 w-4" />
                {busy || printing
                  ? "Preparing…"
                  : receiptMode
                    ? totalLabels
                      ? `Print next batch (${totalLabels})`
                      : "Select labels"
                    : `Print labels (${totalLabels})`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
