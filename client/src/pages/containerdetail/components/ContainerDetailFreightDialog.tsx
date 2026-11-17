// Extracted from ./ContainerDetailErpView.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { useContainerDetailModel } from "../useContainerDetailModel";

type Model = ReturnType<typeof useContainerDetailModel>;

/** "Add Freight Charge" dialog of the ERP container view (never open for a Properties container). */
export function ContainerDetailFreightDialog({
  model,
  isPropertiesContainer,
}: {
  model: Model;
  isPropertiesContainer: boolean;
}) {
  const { showFreightDialog, setShowFreightDialog, freightForm, addFreightMutation } = model;
  return (
    <Dialog open={!isPropertiesContainer && showFreightDialog} onOpenChange={setShowFreightDialog}>
      <DialogContent data-testid="dialog-add-freight">
        <DialogHeader>
          <DialogTitle>Add Freight Charge</DialogTitle>
          <DialogDescription>Record a freight/shipping charge for this container</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={freightForm.handleSubmit((data) => addFreightMutation.mutate(data))}
          className="space-y-4"
        >
          <div>
            <label className="text-sm font-medium">Vendor Name</label>
            <Input
              {...freightForm.register("vendorName")}
              placeholder="Shipping company"
              data-testid="input-freight-vendor"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-sm font-medium">Amount</label>
              <Input
                {...freightForm.register("freightAmount")}
                type="number"
                step="0.01"
                placeholder="0.00"
                data-testid="input-freight-amount"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Currency</label>
              <Select value={freightForm.watch("currency")} onValueChange={(v) => freightForm.setValue("currency", v)}>
                <SelectTrigger data-testid="select-freight-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="XOF">XOF (CFA)</SelectItem>
                  <SelectItem value="EUR">EUR</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Due Date (optional)</label>
            <Input {...freightForm.register("dueDate")} type="date" data-testid="input-freight-due" />
          </div>
          <div>
            <label className="text-sm font-medium">Notes (optional)</label>
            <Textarea
              {...freightForm.register("notes")}
              placeholder="Additional details"
              data-testid="input-freight-notes"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setShowFreightDialog(false)}
              data-testid="button-cancel-freight"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={addFreightMutation.isPending} data-testid="button-submit-freight">
              {addFreightMutation.isPending ? "Adding..." : "Add Freight"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
