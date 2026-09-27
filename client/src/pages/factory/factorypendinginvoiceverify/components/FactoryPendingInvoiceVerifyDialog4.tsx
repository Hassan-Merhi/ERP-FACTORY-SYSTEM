import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CheckCircle } from "lucide-react";
import { fmtNum } from "../utils";
import type { useFactoryPendingInvoiceVerifyModel } from "../useFactoryPendingInvoiceVerifyModel";

type Model = ReturnType<typeof useFactoryPendingInvoiceVerifyModel>;

export function FactoryPendingInvoiceVerifyDialog4({ model }: { model: Model }) {
  const {
    showFinalizePreview,
    setShowFinalizePreview,
    finalizePreview,
    invoiceDate,
    setInvoiceDate,
    finalizeMutation,
    isPending: _isPending,
  } = model;
  return (
    <Dialog open={showFinalizePreview} onOpenChange={setShowFinalizePreview}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Finalize Invoice Preview</DialogTitle>
        </DialogHeader>
        {finalizePreview && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="text-sm">
                <span className="text-muted-foreground">Bales in order:</span>{" "}
                <span className="font-semibold" data-testid="text-preview-total">
                  {finalizePreview.totalBalesInOrder}
                </span>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Will be removed from stock:</span>{" "}
                <span className="font-semibold" data-testid="text-preview-removable">
                  {finalizePreview.baleCount}
                </span>
              </div>
            </div>

            {finalizePreview.baleCount > 0 && (
              <div className="border rounded-md overflow-hidden">
                <Table mobileLayout="cards">
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                      <TableHead>Location</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {finalizePreview.bales.slice(0, 50).map((b) => (
                      <TableRow key={b.id} data-testid={`row-preview-bale-${b.id}`}>
                        <TableCell className="font-mono text-sm">{b.baleReference}</TableCell>
                        <TableCell className="text-sm">{b.productName}</TableCell>
                        <TableCell className="text-right font-mono text-sm">{fmtNum(b.weightKg)}</TableCell>
                        <TableCell className="text-sm">{b.locationName}</TableCell>
                      </TableRow>
                    ))}
                    {finalizePreview.bales.length > 50 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-muted-foreground text-sm">
                          ...and {finalizePreview.bales.length - 50} more bales
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            )}

            {finalizePreview.baleCount === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="text-preview-none">
                No bales are currently in stock for this order. They may have already been marked as SOLD.
              </p>
            )}

            <div className="space-y-3 pt-1">
              <div className="space-y-1">
                <label className="text-sm font-medium">Invoice Date</label>
                <Input
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  data-testid="input-invoice-date"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowFinalizePreview(false)}
                  data-testid="button-cancel-finalize"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    setShowFinalizePreview(false);
                    finalizeMutation.mutate(invoiceDate);
                  }}
                  disabled={finalizeMutation.isPending}
                  data-testid="button-confirm-finalize"
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Confirm & Finalize
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
