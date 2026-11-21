// Extracted from ./AccountDialogs.tsx
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { AccountDialogsProps } from "./accountTypes";

export function AccountDialogsContent({
  bankForm,
  bankToEdit,
  deleteBankMutation,
  handleDeleteBankAccount,
  onBankSubmit,
  setBankToEdit,
  updateBankMutation,
}: Pick<
  AccountDialogsProps,
  | "bankForm"
  | "bankToEdit"
  | "deleteBankMutation"
  | "handleDeleteBankAccount"
  | "onBankSubmit"
  | "setBankToEdit"
  | "updateBankMutation"
>) {
  return (
    <Dialog
      open={!!bankToEdit}
      onOpenChange={(open) => {
        if (!open) {
          setBankToEdit(null);
          bankForm.reset();
        }
      }}
    >
      <DialogContent className="max-w-md w-[95vw] sm:w-auto max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{bankToEdit ? "Edit Bank Account" : "Create Bank Account"}</DialogTitle>
          <DialogDescription>{bankToEdit ? "Update bank account details" : "Add a new bank account"}</DialogDescription>
        </DialogHeader>
        <Form {...bankForm}>
          <form onSubmit={bankForm.handleSubmit(onBankSubmit)} className="space-y-4" noValidate>
            <FormField
              control={bankForm.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Code</FormLabel>
                  <FormControl>
                    <Input placeholder="BANK001" {...field} data-testid="input-bank-code" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={bankForm.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Main Bank Account" {...field} data-testid="input-bank-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={bankForm.control}
              name="bankName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Bank Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Chase Bank" {...field} data-testid="input-bank-bankname" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={bankForm.control}
              name="accountNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Account Number</FormLabel>
                  <FormControl>
                    <Input placeholder="1234567890" {...field} data-testid="input-bank-accountnumber" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={bankForm.control}
              name="routingCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Routing Code (optional)</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="123456789"
                      {...field}
                      value={field.value || ""}
                      data-testid="input-bank-routingcode"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={bankForm.control}
              name="openingBalance"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Opening Balance</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      {...field}
                      value={field.value || "0"}
                      data-testid="input-bank-balance"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={bankForm.control}
              name="openingBalanceSide"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Balance Side</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-bank-balance-side">
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
            <div className="flex justify-between gap-2 pt-2">
              {bankToEdit && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDeleteBankAccount}
                  disabled={deleteBankMutation.isPending}
                  data-testid="button-delete-bank-account"
                >
                  <Trash2 className="w-4 h-4 mr-2" /> Delete
                </Button>
              )}
              <div className="flex gap-2 ml-auto">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setBankToEdit(null);
                    bankForm.reset();
                  }}
                  data-testid="button-cancel-bank-edit"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={updateBankMutation.isPending} data-testid="button-save-bank-edit">
                  {updateBankMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
