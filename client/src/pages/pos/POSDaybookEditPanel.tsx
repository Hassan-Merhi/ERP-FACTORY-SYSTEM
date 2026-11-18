import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { locationInventoryLightUrl, invalidateLocationInventoryQueries } from "@/api/inventoryApi";
import { useToast } from "@/hooks/use-toast";
import type { APIInventoryItem } from "./pos-components/posTypes";
import type { VoucherWithItems } from "./posdaybook/types";
import { buildDaybookSaleEditPayload, createDaybookDraftLines, previewDaybookSaleTotals } from "./posdaybook/editSalePayload";

export function POSDaybookEditPanel({
  sale,
  onCancel,
  onSaved,
}: {
  sale: VoucherWithItems;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [lines, setLines] = useState(() => createDaybookDraftLines(sale));
  const [description, setDescription] = useState(sale.description ?? "");
  const preview = previewDaybookSaleTotals(lines);
  const nativeCurrencyLabel = sale.currency === "ZMW" ? "K" : sale.currency || "USD";
  const inventoryUrl = locationInventoryLightUrl(sale.locationId, true);
  const { data: availableItems = [] } = useQuery<APIInventoryItem[]>({ queryKey: [inventoryUrl] });
  const mutation = useMutation({
    mutationFn: async () => {
      const payload = buildDaybookSaleEditPayload(sale, lines, description);
      const response = await apiRequest("PUT", `/api/vouchers/${sale.id}/sales`, payload);
      return response.json();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [`/api/vouchers/${sale.id}`] });
      void queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      invalidateLocationInventoryQueries(sale.locationId);
      toast({ title: "Sale updated", description: `Receipt ${sale.voucherNumber} was saved.` });
      onSaved();
    },
    onError: (error: Error) => {
      toast({ title: "Unable to update sale", description: error.message, variant: "destructive" });
    },
  });

  const updateLine = (index: number, field: "quantity" | "unitPrice", value: string) => {
    setLines((previous) => previous.map((line, i) => (i === index ? { ...line, [field]: value } : line)));
  };

  return (
    <div className="space-y-4" data-testid="pos-daybook-inline-editor">
      <p className="text-sm text-muted-foreground">
        Editing receipt {sale.voucherNumber} from {sale.voucherDate}. The original date, location and payment account
        cannot be changed.
      </p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[540px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="p-2 text-left">Item</th>
              <th className="p-2 text-right">Qty</th>
              <th className="p-2 text-right">Price ({nativeCurrencyLabel})</th>
              <th className="p-2 text-right">Line Total</th>
              <th className="p-2 text-right">Remove</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.id ?? `added-${line.stockItemId}-${index}`} className="border-b last:border-0">
                <td className="p-2">{line.stockItemName}</td>
                <td className="p-2">
                  <Input
                    aria-label={`Quantity ${line.stockItemName}`}
                    type="number"
                    step="any"
                    min="0.001"
                    value={line.quantity}
                    onChange={(event) => updateLine(index, "quantity", event.target.value)}
                    className="ml-auto w-24 text-right"
                  />
                </td>
                <td className="p-2">
                  <Input
                    aria-label={`Price ${line.stockItemName}`}
                    type="number"
                    step={sale.currency === "ZMW" ? "0.01" : "any"}
                    min="0.01"
                    value={line.unitPrice}
                    onChange={(event) => updateLine(index, "unitPrice", event.target.value)}
                    className="ml-auto w-32 text-right"
                  />
                </td>
                <td className="p-2 text-right font-mono">{preview?.lineTotals[index] ?? "—"}</td>
                <td className="p-2 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${line.stockItemName}`}
                    disabled={lines.length <= 1}
                    onClick={() => setLines((old) => old.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Label htmlFor="pos-daybook-add-item" className="shrink-0 text-xs">
          <Plus className="mr-1 inline h-4 w-4" />
          Add item
        </Label>
        <Select
          value=""
          onValueChange={(id) => {
            const item = availableItems.find((entry) => entry.stockItemId === Number(id));
            if (item) {
              setLines((old) => [...old, {
                stockItemId: item.stockItemId,
                stockItemName: item.stockItemName,
                quantity: "1",
                unitPrice: "",
              }]);
            }
          }}
        >
          <SelectTrigger id="pos-daybook-add-item" data-testid="pos-daybook-add-item" className="max-w-sm">
            <SelectValue placeholder="Choose a stock item..." />
          </SelectTrigger>
          <SelectContent>
            {availableItems.map((item) => (
              <SelectItem key={item.stockItemId} value={String(item.stockItemId)}>
                {item.stockItemName} ({item.stockItemCode})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-right text-base font-semibold" data-testid="pos-daybook-edit-total">
        New total: {nativeCurrencyLabel} {preview?.total ?? "—"}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="pos-daybook-edit-notes">Notes</Label>
        <Textarea id="pos-daybook-edit-notes" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2 border-t pt-3">
        <Button type="button" variant="outline" onClick={onCancel} disabled={mutation.isPending}>
          Cancel editing
        </Button>
        <Button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending || preview === null}
          data-testid="pos-daybook-save-edit"
        >
          {mutation.isPending ? "Saving..." : "Save sale changes"}
        </Button>
      </div>
    </div>
  );
}
