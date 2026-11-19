// Extracted from ./AccountDialogs.tsx
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { AccountDialogsProps } from "./accountTypes";

export function EditAccountDialog({
  accountToEdit,
  supplierToEdit,
  customerToEdit,
  employeeToEdit,
  setAccountToEdit,
  setSupplierToEdit,
  setCustomerToEdit,
  setEmployeeToEdit,
  editForm,
  onEditSubmit,
  handleDeleteAccount,
  updateLedgerMutation,
}: {
  accountToEdit: AccountDialogsProps["accountToEdit"];
  supplierToEdit: AccountDialogsProps["supplierToEdit"];
  customerToEdit: AccountDialogsProps["customerToEdit"];
  employeeToEdit: AccountDialogsProps["employeeToEdit"];
  setAccountToEdit: AccountDialogsProps["setAccountToEdit"];
  setSupplierToEdit: AccountDialogsProps["setSupplierToEdit"];
  setCustomerToEdit: AccountDialogsProps["setCustomerToEdit"];
  setEmployeeToEdit: AccountDialogsProps["setEmployeeToEdit"];
  editForm: AccountDialogsProps["editForm"];
  onEditSubmit: AccountDialogsProps["onEditSubmit"];
  handleDeleteAccount: AccountDialogsProps["handleDeleteAccount"];
  updateLedgerMutation: AccountDialogsProps["updateLedgerMutation"];
}) {
  return (
    <Dialog
      open={!!(accountToEdit || supplierToEdit || customerToEdit || employeeToEdit)}
      onOpenChange={(open) => {
        if (!open) {
          setAccountToEdit(null);
          setSupplierToEdit(null);
          setCustomerToEdit(null);
          setEmployeeToEdit(null);
          editForm.reset();
        }
      }}
    >
      <DialogContent className="max-w-md w-[95vw] sm:w-auto max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {supplierToEdit
              ? "Edit Supplier"
              : customerToEdit
                ? "Edit Customer"
                : employeeToEdit
                  ? "Edit Employee"
                  : "Edit Ledger Account"}
          </DialogTitle>
          <DialogDescription>Update account details</DialogDescription>
        </DialogHeader>
        <Form {...editForm}>
          <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4" noValidate>
            <FormField
              control={editForm.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Code</FormLabel>
                  <FormControl>
                    <Input {...field} readOnly className="bg-muted font-mono text-sm" data-testid="input-edit-code" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={editForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Name</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-edit-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {!supplierToEdit && !customerToEdit && !employeeToEdit && (
              <FormField
                control={editForm.control}
                name="accountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Account Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-edit-type">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="Asset">Asset</SelectItem>
                        <SelectItem value="Liability">Liability</SelectItem>
                        <SelectItem value="Equity">Equity</SelectItem>
                        <SelectItem value="Income">Income</SelectItem>
                        <SelectItem value="Expense">Expense</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
            {(accountToEdit || supplierToEdit || customerToEdit) && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <FormField
                  control={editForm.control}
                  name="openingBalance"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Opening Balance</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          step="0.01"
                          {...field}
                          value={field.value || "0"}
                          data-testid="input-edit-balance"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="openingBalanceSide"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Balance Side</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value || "Dr"}>
                        <FormControl>
                          <SelectTrigger data-testid="select-edit-balance-side">
                            <SelectValue placeholder="Dr/Cr" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Dr">Dr (Debit)</SelectItem>
                          <SelectItem value="Cr">Cr (Credit)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}
            <FormField
              control={editForm.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3 shadow-xs">
                  <div className="space-y-0.5">
                    <FormLabel>Active Status</FormLabel>
                    <div className="text-[11px] text-muted-foreground">Account is available for new entries</div>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} data-testid="switch-edit-active" />
                  </FormControl>
                </FormItem>
              )}
            />
            <div className="flex justify-between gap-2 pt-2">
              <Button
                type="button"
                variant="destructive"
                onClick={handleDeleteAccount}
                data-testid="button-delete-account"
              >
                <Trash2 className="w-4 h-4 mr-2" /> Delete
              </Button>
              <div className="flex gap-2 ml-auto">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setAccountToEdit(null);
                    setSupplierToEdit(null);
                    setCustomerToEdit(null);
                    setEmployeeToEdit(null);
                    editForm.reset();
                  }}
                  data-testid="button-cancel-edit"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={updateLedgerMutation.isPending} data-testid="button-save-edit">
                  {updateLedgerMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
