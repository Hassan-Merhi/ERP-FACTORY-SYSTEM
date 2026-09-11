import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Plus, X, CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { CurrencySelector } from "@/components/CurrencySelector";
import { AccountAutocomplete, CombinedAccount } from "@/components/AccountAutocomplete";
import { cn } from "@/lib/utils";
import type { VoucherFormData } from "./VoucherEditSchemas";

export function PaymentReceiptEditForm({
  form,
  voucherType,
  onSubmit,
  onCancel,
  isPending,
  allAccountsWithBalances,
  formatDisplayDate,
  formatAmount,
  total,
  focusByTestId,
}: {
  form: UseFormReturn<VoucherFormData>;
  voucherType: string;
  onSubmit: (data: VoucherFormData) => void;
  onCancel: () => void;
  isPending: boolean;
  allAccountsWithBalances: CombinedAccount[];
  formatDisplayDate: (date: Date) => string;
  formatAmount: (amount: number) => string;
  total: number;
  focusByTestId: (testId: string, select?: boolean) => void;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "entries",
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit {voucherType} Voucher</CardTitle>
        <CardDescription>Update voucher details and entries</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
            <div className="flex flex-col md:flex-row items-stretch md:items-start justify-between gap-4">
              <FormField
                control={form.control}
                name="paymentAccountId"
                render={({ field: _field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>{voucherType === "Payment" ? "Pay From" : "Receive In"}</FormLabel>
                    <FormControl>
                      <AccountAutocomplete
                        value={
                          form.watch("paymentAccountId") > 0
                            ? {
                                type: form.watch("paymentAccountType"),
                                id: form.watch("paymentAccountId"),
                                name: form.watch("paymentAccountName"),
                              }
                            : null
                        }
                        onChange={(type, id, name) => {
                          if (
                            type === "ledger" ||
                            type === "bank" ||
                            type === "supplier" ||
                            type === "factorySupplier"
                          ) {
                            form.setValue("paymentAccountType", type);
                            form.setValue("paymentAccountId", id);
                            form.setValue("paymentAccountName", name);
                          }
                        }}
                        allAccounts={allAccountsWithBalances}
                        rowIndex={-1}
                        testId="input-payment-account"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="paymentAccountNarration"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>Narration</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ""} placeholder="Narration for this account" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="voucherDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            className={cn(
                              "w-full md:w-[200px] justify-start text-left font-normal",
                              !field.value && "text-muted-foreground"
                            )}
                            data-testid="button-date-picker"
                          >
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {field.value ? formatDisplayDate(field.value) : "Pick a date"}
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="end">
                        <Calendar mode="single" selected={field.value} onSelect={field.onChange} initialFocus />
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Currency</FormLabel>
                    <FormControl>
                      <CurrencySelector value={field.value} onChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="md:hidden space-y-3">
              {fields.map((field, index) => (
                <div key={field.id} className="border rounded-md p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-muted-foreground">Entry {index + 1}</span>
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(index)}
                        data-testid={`button-remove-payment-mobile-${index}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <FormField
                    control={form.control}
                    name={`entries.${index}.accountId`}
                    render={({ field: _accountField }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Account</FormLabel>
                        <FormControl>
                          <AccountAutocomplete
                            value={
                              form.watch(`entries.${index}.accountId`) > 0
                                ? {
                                    type: form.watch(`entries.${index}.accountType`),
                                    id: form.watch(`entries.${index}.accountId`),
                                    name: form.watch(`entries.${index}.accountName`),
                                  }
                                : null
                            }
                            onChange={(type, id, name) => {
                              if (
                                type === "ledger" ||
                                type === "bank" ||
                                type === "supplier" ||
                                type === "factorySupplier"
                              ) {
                                form.setValue(`entries.${index}.accountType`, type);
                                form.setValue(`entries.${index}.accountId`, id);
                                form.setValue(`entries.${index}.accountName`, name);
                              }
                            }}
                            allAccounts={allAccountsWithBalances}
                            rowIndex={index}
                            testId={`input-account-payment-mobile-${index}`}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`entries.${index}.amount`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Amount</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            step="0.01"
                            placeholder="0.00"
                            className="font-mono"
                            data-testid={`input-amount-payment-mobile-${index}`}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name={`entries.${index}.narration`}
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs">Narration</FormLabel>
                        <FormControl>
                          <Input {...field} value={field.value ?? ""} placeholder="Optional note" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              ))}
              <div className="flex items-center justify-between gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => append({ accountType: "ledger", accountId: 0, accountName: "", amount: "" })}
                  data-testid="button-add-row-payment-mobile"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Row
                </Button>
                <div className="text-right">
                  <div className="text-sm text-muted-foreground">Total</div>
                  <div className="font-bold font-mono">{formatAmount(total)}</div>
                </div>
              </div>
            </div>

            <div className="hidden md:block border rounded-md overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted/50 sticky top-0 z-30">
                  <tr>
                    <th className="text-left p-3 font-medium w-[50%]">Account</th>
                    <th className="text-left p-3 font-medium w-[20%]">Amount</th>
                    <th className="text-left p-3 font-medium w-[25%]">Narration</th>
                    <th className="w-[5%]"></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => (
                    <tr key={field.id} className="border-t">
                      <td className="p-2">
                        <FormField
                          control={form.control}
                          name={`entries.${index}.accountId`}
                          render={({ field: _accountField }) => (
                            <FormItem>
                              <FormControl>
                                <AccountAutocomplete
                                  value={
                                    form.watch(`entries.${index}.accountId`) > 0
                                      ? {
                                          type: form.watch(`entries.${index}.accountType`),
                                          id: form.watch(`entries.${index}.accountId`),
                                          name: form.watch(`entries.${index}.accountName`),
                                        }
                                      : null
                                  }
                                  onChange={(type, id, name) => {
                                    if (
                                      type === "ledger" ||
                                      type === "bank" ||
                                      type === "supplier" ||
                                      type === "factorySupplier"
                                    ) {
                                      form.setValue(`entries.${index}.accountType`, type);
                                      form.setValue(`entries.${index}.accountId`, id);
                                      form.setValue(`entries.${index}.accountName`, name);
                                    }
                                  }}
                                  allAccounts={allAccountsWithBalances}
                                  rowIndex={index}
                                  testId={`input-account-${index}`}
                                  onArrowUp={() => index > 0 && focusByTestId(`input-account-${index - 1}`)}
                                  onArrowDown={() =>
                                    index < fields.length - 1 && focusByTestId(`input-account-${index + 1}`)
                                  }
                                  onArrowRight={() => focusByTestId(`input-amount-${index}`, true)}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </td>
                      <td className="p-2">
                        <FormField
                          control={form.control}
                          name={`entries.${index}.amount`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input
                                  {...field}
                                  type="number"
                                  step="0.01"
                                  placeholder="0.00"
                                  className="font-mono"
                                  data-testid={`input-amount-${index}`}
                                  onKeyDown={(e) => {
                                    if (e.key === "ArrowUp" && index > 0) {
                                      e.preventDefault();
                                      focusByTestId(`input-amount-${index - 1}`, true);
                                    } else if (e.key === "ArrowDown" && index < fields.length - 1) {
                                      e.preventDefault();
                                      focusByTestId(`input-amount-${index + 1}`, true);
                                    } else if (e.key === "ArrowLeft") {
                                      e.preventDefault();
                                      focusByTestId(`input-account-${index}`);
                                    }
                                  }}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </td>
                      <td className="p-2">
                        <FormField
                          control={form.control}
                          name={`entries.${index}.narration`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input {...field} value={field.value ?? ""} placeholder="Optional note" />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </td>
                      <td className="p-2">
                        {fields.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => remove(index)}
                            data-testid={`button-remove-${index}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted/30 border-t-2">
                  <tr>
                    <td colSpan={2} className="p-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          append({
                            accountType: "ledger",
                            accountId: 0,
                            accountName: "",
                            amount: "",
                          })
                        }
                        data-testid="button-add-row"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Add Row
                      </Button>
                    </td>
                    <td className="p-3">
                      <div className="text-right font-bold font-mono">{formatAmount(total)}</div>
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea {...field} placeholder="Additional notes..." rows={3} data-testid="input-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={onCancel}
                disabled={isPending}
                data-testid="button-cancel"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending || total === 0} data-testid="button-save-changes">
                {isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
