import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./ContainerDetailErpView.tsx
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ContainerDetailErpViewModel, ContainerErpView } from "./ContainerDetailErpViewModel";

export function ContainerErpSellDialog({ m, v }: { m: ContainerDetailErpViewModel; v: ContainerErpView }) {
  return (
    <Dialog open={m.showSellDialog} onOpenChange={m.setShowSellDialog}>
      <DialogContent data-testid="dialog-sell-container">
        <DialogHeader>
          <DialogTitle>Sell Container</DialogTitle>
          <DialogDescription>
            Record the sale of container {v.container.containerNumber} to a customer.
          </DialogDescription>
        </DialogHeader>
        <Form {...m.form}>
          <form noValidate onSubmit={m.form.handleSubmit(m.handleSellSubmit)} className="space-y-4">
            <FormField
              control={m.form.control}
              name="customerId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Customer</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger data-testid="select-customer">
                        <SelectValue placeholder="Select a customer" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {m.customers.map((customer) => (
                        <SelectItem key={customer.id} value={customer.id.toString()}>
                          {customer.legalName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={m.form.control}
              name="saleDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Sale Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} data-testid="input-sale-date" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="rounded-md border p-4 bg-muted/50">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium">Container Cost</span>
                <span className="text-lg font-bold">{m.formatAmount(v.grandTotal)}</span>
              </div>
              <p className="text-xs text-muted-foreground">Full balance will be charged to customer</p>
            </div>

            <FormField
              control={m.form.control}
              name="commission"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Commission</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" placeholder="0.00" {...field} data-testid="input-commission" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={m.form.control}
              name="commissionAccountId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Commission Account (Optional)</FormLabel>
                  <UnifiedAccountPicker
                    value={field.value}
                    onChange={field.onChange}
                    options={m.incomeAccounts.map((account) => ({
                      value: String(account.id),
                      name: account.name,
                    }))}
                    placeholder="Default commission account"
                    testId="select-commission-account"
                    allowClear
                  />
                  <p className="text-xs text-muted-foreground">Leave empty to use default commission revenue account</p>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => m.setShowSellDialog(false)}
                data-testid="button-cancel-sale"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={m.sellContainerMutation.isPending} data-testid="button-submit-sale">
                {m.sellContainerMutation.isPending ? "Processing..." : "Record Sale"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
