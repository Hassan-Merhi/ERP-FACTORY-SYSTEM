// Extracted from ./ContainerDetailPage.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSpContainerDetailViewState } from "./useSpContainerDetailViewState";

export function SpContainerDetailViewDialogSection({
  editForm,
  editMutation,
  setShowEditDialog,
  showEditDialog,
  suppliers,
}: Pick<
  ReturnType<typeof useSpContainerDetailViewState>,
  "editForm" | "editMutation" | "setShowEditDialog" | "showEditDialog" | "suppliers"
>) {
  return (
    <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Container</DialogTitle>
          <DialogDescription>
            Update the container details. The accounting voucher (Dr Goods OTW / Cr OTW Clearing) will be regenerated
            automatically.
          </DialogDescription>
        </DialogHeader>
        <Form {...editForm}>
          <form onSubmit={editForm.handleSubmit((d) => editMutation.mutate(d))} className="space-y-4" noValidate>
            <FormField
              control={editForm.control}
              name="supplierId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Supplier</FormLabel>
                  <Select
                    value={field.value ? String(field.value) : ""}
                    onValueChange={(val) => {
                      const numId = parseInt(val);
                      field.onChange(numId);
                      const found = suppliers.find((s) => s.id === numId);
                      if (found) editForm.setValue("supplierName", found.legalName);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="select-edit-supplier">
                        <SelectValue placeholder="Select supplier…" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {suppliers.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {s.legalName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={editForm.control}
              name="supplierName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Supplier Name <span className="text-muted-foreground text-xs font-normal">(override)</span>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-edit-supplier-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={editForm.control}
                name="invoiceNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Invoice Number</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-edit-invoice-number" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="containerNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Container No. <span className="text-muted-foreground text-xs font-normal">(opt.)</span>
                    </FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="ABCD1234567" data-testid="input-edit-container-number" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="invoiceDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Invoice Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} data-testid="input-edit-invoice-date" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="invoiceTotalUsd"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Invoice Total (USD)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} data-testid="input-edit-invoice-total" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="discountPct"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Discount %</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} data-testid="input-edit-discount-pct" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="freightEstimateUsd"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Freight Estimate (USD)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} data-testid="input-edit-freight-estimate" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={editForm.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Notes <span className="text-muted-foreground text-xs font-normal">(opt.)</span>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-edit-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowEditDialog(false)}
                data-testid="button-edit-cancel"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={editMutation.isPending} data-testid="button-edit-submit">
                {editMutation.isPending ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
