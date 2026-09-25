import { Button } from "@/components/ui/button";
import { DollarSign } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { useFactoryInvoiceDetailModel } from "../useFactoryInvoiceDetailModel";

type Model = ReturnType<typeof useFactoryInvoiceDetailModel>;

export function FactoryInvoiceDetailDialog3({ model }: { model: Model }) {
  const {
    showProformaDialog,
    setShowProformaDialog,
    selectedProformaId,
    setSelectedProformaId,
    order: _order,
    proformas,
    selectedProforma,
    applyProformaMutation,
  } = model;
  return (
    <Dialog open={showProformaDialog} onOpenChange={setShowProformaDialog}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Apply Proforma Prices</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Select a proforma to apply its article prices to all matching bales in this order.
          </p>
          {proformas.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">No proformas found for this customer.</p>
          ) : (
            <Select value={selectedProformaId} onValueChange={setSelectedProformaId}>
              <SelectTrigger data-testid="select-proforma">
                <SelectValue placeholder="Select a proforma..." />
              </SelectTrigger>
              <SelectContent>
                {proformas.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)} data-testid={`option-proforma-${p.id}`}>
                    {p.name} ({p.lineCount} line{p.lineCount !== 1 ? "s" : ""})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {selectedProformaId && selectedProforma?.lines?.length ? (
            <div className="rounded-md border p-3 space-y-1 max-h-48 overflow-y-auto">
              <p className="text-xs font-medium text-muted-foreground mb-2">Price lines in this proforma:</p>
              {selectedProforma.lines.map((l, i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{l.articleCode}</span>
                  <span className="font-medium">${parseFloat(l.pricePerBale).toFixed(2)}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => setShowProformaDialog(false)} data-testid="button-cancel-proforma">
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (selectedProformaId) applyProformaMutation.mutate(parseInt(selectedProformaId));
              }}
              disabled={!selectedProformaId || applyProformaMutation.isPending}
              data-testid="button-confirm-proforma"
            >
              <DollarSign className="mr-2 h-4 w-4" />
              {applyProformaMutation.isPending ? "Applying…" : "Apply Prices"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
