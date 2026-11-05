import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney, formatNumber } from "./customerLoadingFormat";
import type { SelectedLine, SelectedTotals } from "./customerLoadingTypes";

interface CustomerLoadingProformaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerName?: string;
  proformaName: string;
  onProformaNameChange: (value: string) => void;
  destination: string;
  onDestinationChange: (value: string) => void;
  lines: SelectedLine[];
  totals: SelectedTotals;
  isPending: boolean;
  onCreate: () => void;
}

export function CustomerLoadingProformaDialog({
  open,
  onOpenChange,
  customerName,
  proformaName,
  onProformaNameChange,
  destination,
  onDestinationChange,
  lines,
  totals,
  isPending,
  onCreate,
}: CustomerLoadingProformaDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Review Proforma</DialogTitle>
          <DialogDescription>
            Creating this proforma does not mark any bale as loaded. Loading history only changes when bales are scanned
            into a loading session.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 overflow-auto px-6 py-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label>Customer</Label>
              <div className="mt-1 rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium">{customerName}</div>
            </div>
            <div>
              <Label htmlFor="customer-loading-proforma-name">Proforma Name</Label>
              <Input
                id="customer-loading-proforma-name"
                value={proformaName}
                onChange={(e) => onProformaNameChange(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="customer-loading-proforma-destination">Destination <span className="text-destructive">*</span></Label>
            <Input
              id="customer-loading-proforma-destination"
              value={destination}
              onChange={(event) => onDestinationChange(event.target.value)}
              placeholder="e.g. L'SHI, MALI, KINSHASA"
              list="customer-loading-destinations"
            />
            <datalist id="customer-loading-destinations">
              <option value="L'SHI" />
              <option value="MALI" />
              <option value="KINSHASA" />
            </datalist>
          </div>
          <div className="overflow-auto rounded-md border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">KG</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.product.id} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{line.product.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {line.product.articleCode || line.product.code}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{line.quantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(line.totalKg, 1)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(line.pricePerBale)}</td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/40 font-semibold">
                  <td className="px-3 py-2">Grand Total</td>
                  <td className="px-3 py-2 text-right">{formatNumber(totals.quantity)}</td>
                  <td className="px-3 py-2 text-right">{formatNumber(totals.kg, 1)}</td>
                  <td></td>
                  <td className="px-3 py-2 text-right">{formatMoney(totals.amount)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <DialogFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Back
          </Button>
          <Button onClick={onCreate} disabled={isPending || !proformaName.trim() || !destination.trim()}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create Proforma
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
