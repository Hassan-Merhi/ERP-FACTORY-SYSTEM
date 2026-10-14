import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { useContainerDetailModel } from "../useContainerDetailModel";

type Model = ReturnType<typeof useContainerDetailModel>;
export function ContainerDetailDialog1({ model }: { model: Model }) {
  const { showPaymentDialog, setShowPaymentDialog, paymentForm, addPaymentMutation } = model;
  return (
    <Dialog
      open={showPaymentDialog !== null}
      onOpenChange={(open) => {
        if (!open) setShowPaymentDialog(null);
      }}
    >
      <DialogContent data-testid="dialog-add-payment">
        <DialogHeader>
          <DialogTitle>Record Payment</DialogTitle>
          <DialogDescription>Record a payment toward this freight charge</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={paymentForm.handleSubmit((data) => {
            if (showPaymentDialog !== null) addPaymentMutation.mutate({ freightId: showPaymentDialog, data });
          })}
          className="space-y-4"
        >
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-sm font-medium">Payment Date</label>
              <Input {...paymentForm.register("paymentDate")} type="date" data-testid="input-payment-date" />
            </div>
            <div>
              <label className="text-sm font-medium">Amount</label>
              <Input
                {...paymentForm.register("amount")}
                type="number"
                step="0.01"
                placeholder="0.00"
                data-testid="input-payment-amount"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-sm font-medium">Method</label>
              <Select value={paymentForm.watch("method")} onValueChange={(v) => paymentForm.setValue("method", v)}>
                <SelectTrigger data-testid="select-payment-method">
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Cash">Cash</SelectItem>
                  <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                  <SelectItem value="Mobile Money">Mobile Money</SelectItem>
                  <SelectItem value="Check">Check</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Reference</label>
              <Input
                {...paymentForm.register("reference")}
                placeholder="Transaction ref"
                data-testid="input-payment-reference"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowPaymentDialog(null)}
              data-testid="button-cancel-payment"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={addPaymentMutation.isPending} data-testid="button-submit-payment">
              {addPaymentMutation.isPending ? "Recording..." : "Record Payment"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
