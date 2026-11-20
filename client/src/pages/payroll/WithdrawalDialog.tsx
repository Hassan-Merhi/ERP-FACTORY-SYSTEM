import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

interface WithdrawalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedEmployee: PayrollModel["selectedEmployee"];
  form: PayrollModel["withdrawalForm"];
  mutation: PayrollModel["withdrawalMutation"];
  cashAccounts: PayrollModel["cashAccounts"];
  bankAccounts: PayrollModel["bankAccounts"];
  bankAccountsLoading: boolean;
}

export function WithdrawalDialog({
  open,
  onOpenChange,
  selectedEmployee,
  form,
  mutation,
  cashAccounts,
  bankAccounts,
  bankAccountsLoading,
}: WithdrawalDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-withdrawal">
        <DialogHeader>
          <DialogTitle>Withdraw Salary</DialogTitle>
          <DialogDescription>
            Withdraw from {selectedEmployee?.firstName} {selectedEmployee?.lastName}'s balance:{" "}
            {selectedEmployee?.currentBalance}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form noValidate onSubmit={form.handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      {...field}
                      data-testid="input-withdrawal-amount"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="paymentAccountType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Payment From</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-withdrawal-account-type">
                        <SelectValue placeholder="Select account type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="bank">Bank Account</SelectItem>
                      <SelectItem value="cash">Cash Account</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="paymentAccountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{form.watch("paymentAccountType") === "cash" ? "Cash Account" : "Bank Account"}</FormLabel>
                  <UnifiedAccountPicker
                    options={(form.watch("paymentAccountType") === "cash"
                      ? cashAccounts
                      : bankAccounts ?? []
                    ).map((account) => ({ value: String(account.id), name: account.name }))}
                    value={field.value}
                    onChange={field.onChange}
                    placeholder={bankAccountsLoading && form.watch("paymentAccountType") !== "cash"
                      ? "Loading bank accounts..."
                      : "Select account"}
                    disabled={bankAccountsLoading && form.watch("paymentAccountType") !== "cash"}
                    testId="select-withdrawal-account"
                  />
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} data-testid="input-withdrawal-date" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (Optional)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Additional notes..." {...field} data-testid="input-withdrawal-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                data-testid="button-cancel-withdrawal"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending} data-testid="button-submit-withdrawal">
                {mutation.isPending ? "Processing..." : "Withdraw"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
