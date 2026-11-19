import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { VoucherEditDialogContent, type VoucherEditDialogProps } from "./VoucherEditDialogContent";

export function VoucherEditDialog({
  open,
  onOpenChange,
  voucherToEdit,
  entriesLoading,
  editForm,
  editFields,
  editAppend,
  editRemove,
  handleSaveEdit,
  editMutationPending,
  ledgerAccounts,
  bankAccounts,
  suppliers,
  employees,
  fixedAssets,
  formatAmount,
}: VoucherEditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-[95vw] md:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Voucher</DialogTitle>
          <DialogDescription>Edit all voucher details. Debits must equal credits.</DialogDescription>
        </DialogHeader>
        {voucherToEdit && !entriesLoading && (
          <Form {...editForm}>
            <form onSubmit={editForm.handleSubmit(handleSaveEdit)} className="space-y-4" noValidate>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Voucher Number</p>
                  <p className="font-mono font-medium">{voucherToEdit.voucherNumber}</p>
                </div>

                <FormField
                  control={editForm.control}
                  name="voucherDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} data-testid="input-edit-voucher-date" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField
                  control={editForm.control}
                  name="voucherType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-edit-voucher-type">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Journal">Journal</SelectItem>
                          <SelectItem value="Payment">Payment</SelectItem>
                          <SelectItem value="Receipt">Receipt</SelectItem>
                          <SelectItem value="Stock Transfer">Stock Transfer</SelectItem>
                          <SelectItem value="Sales">Sales</SelectItem>
                          <SelectItem value="Purchase">Purchase</SelectItem>
                          <SelectItem value="Contra">Contra</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={editForm.control}
                  name="optional"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-center justify-between rounded-md border p-3 space-y-0">
                      <div className="space-y-0.5">
                        <FormLabel className="text-sm">Optional</FormLabel>
                        <div className="text-xs text-muted-foreground">Does not affect books</div>
                      </div>
                      <FormControl>
                        <Switch
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          data-testid="switch-edit-optional"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={editForm.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="Enter voucher description (optional)"
                        rows={2}
                        data-testid="textarea-edit-description"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <VoucherEditDialogContent
                bankAccounts={bankAccounts}
                editAppend={editAppend}
                editFields={editFields}
                editForm={editForm}
                editRemove={editRemove}
                employees={employees}
                fixedAssets={fixedAssets}
                formatAmount={formatAmount}
                ledgerAccounts={ledgerAccounts}
                suppliers={suppliers}
              />

              <div className="flex justify-end gap-2 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  data-testid="button-cancel-edit"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={editMutationPending} data-testid="button-save-edit">
                  {editMutationPending ? "Updating…" : "Update"}
                </Button>
              </div>
            </form>
          </Form>
        )}
        {entriesLoading && (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
