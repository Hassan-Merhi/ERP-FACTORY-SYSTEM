import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { useCurrencyContext } from "@/contexts/CurrencyContext";

interface BulkPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedPayments: PayrollModel["selectedPaymentsSummary"];
  totalAmount: number;
  workerStaff: PayrollModel["workerStaff"];
  form: PayrollModel["bulkPaymentForm"];
  mutation: PayrollModel["bulkPaymentMutation"];
  cashAccounts: PayrollModel["cashAccounts"];
  bankAccounts: PayrollModel["bankAccounts"];
  bankAccountsLoading: boolean;
}

export function BulkPaymentDialog({
  open,
  onOpenChange,
  selectedPayments,
  totalAmount,
  workerStaff,
  form,
  mutation,
  cashAccounts,
  bankAccounts,
  bankAccountsLoading,
}: BulkPaymentDialogProps) {
  const { formatAmount } = useCurrencyContext();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-bulk-payment" className="max-w-4xl w-[95vw]">
        <DialogHeader>
          <DialogTitle>Process Bulk Payment</DialogTitle>
          <DialogDescription>
            Pay {selectedPayments.length} workers - Total amount: {formatAmount(totalAmount)}
          </DialogDescription>
        </DialogHeader>

        <div className="border rounded-md p-4 mb-4 bg-muted/30 max-h-60 overflow-y-auto">
          <h4 className="font-semibold mb-3">Payment Summary</h4>
          <div className="space-y-2">
            {selectedPayments.map((payment) => {
              const worker = workerStaff.find((w) => w.id === payment.workerId);
              return (
                <div key={payment.workerId} className="flex justify-between text-sm">
                  <span>
                    {worker?.firstName} {worker?.lastName} ({worker?.code})
                  </span>
                  <span className="font-mono">{formatAmount(parseFloat(payment.amount))}</span>
                </div>
              );
            })}
            <div className="pt-2 border-t mt-3 flex justify-between font-semibold">
              <span>Total</span>
              <span className="font-mono">{formatAmount(totalAmount)}</span>
            </div>
          </div>
        </div>

        <Form {...form}>
          <form noValidate onSubmit={form.handleSubmit((data) => mutation.mutate(data))} className="space-y-4">
            <FormField
              control={form.control}
              name="paymentAccountType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Payment From</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-bulk-account-type">
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
                    testId="select-bulk-account"
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
                  <FormLabel>Payment Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} data-testid="input-bulk-date" />
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
                    <Textarea placeholder="Additional notes..." {...field} data-testid="input-bulk-notes" />
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
                data-testid="button-cancel-bulk"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending} data-testid="button-submit-bulk">
                {mutation.isPending ? "Processing..." : `Pay ${selectedPayments.length} Workers`}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
