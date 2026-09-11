import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Plus, X, CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CurrencySelector } from "@/components/CurrencySelector";
import { AccountAutocomplete, CombinedAccount } from "@/components/AccountAutocomplete";
import { cn } from "@/lib/utils";
import type { JournalFormData } from "./VoucherEditSchemas";

export function JournalEditForm({
  form,
  onSubmit,
  onCancel,
  isPending,
  allAccountsWithBalances,
  formatDisplayDate,
  formatAmount,
  drTotal,
  crTotal,
  focusByTestId,
}: {
  form: UseFormReturn<JournalFormData>;
  onSubmit: (data: JournalFormData) => void;
  onCancel: () => void;
  isPending: boolean;
  allAccountsWithBalances: CombinedAccount[];
  formatDisplayDate: (date: Date) => string;
  formatAmount: (amount: number) => string;
  drTotal: number;
  crTotal: number;
  focusByTestId: (testId: string, select?: boolean) => void;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "entries",
  });

  const totalsMatch = Math.abs(drTotal - crTotal) < 0.01 && drTotal > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Journal Voucher</CardTitle>
        <CardDescription>Update journal entries (debits must equal credits)</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
            <div className="flex flex-col md:flex-row items-stretch md:items-start justify-between gap-4">
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
                      <PopoverContent className="w-auto p-0" align="start">
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
                    {fields.length > 2 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => remove(index)}
                        data-testid={`button-remove-journal-mobile-${index}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name={`entries.${index}.type`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">Type</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger data-testid={`select-type-journal-mobile-${index}`}>
                                <SelectValue placeholder="Type" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="DR">DR</SelectItem>
                              <SelectItem value="CR">CR</SelectItem>
                            </SelectContent>
                          </Select>
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
                              data-testid={`input-amount-journal-mobile-${index}`}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
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
                            testId={`input-account-journal-mobile-${index}`}
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
                      <FormItem className="col-span-2">
                        <FormLabel className="text-xs">Narration</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value ?? ""}
                            placeholder="Optional note for this entry"
                            data-testid={`input-narration-journal-mobile-${index}`}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              ))}
              <div className="flex flex-col gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    append({
                      type: "DR",
                      accountType: "ledger",
                      accountId: 0,
                      accountName: "",
                      amount: "",
                      narration: "",
                    })
                  }
                  data-testid="button-add-row-journal-mobile"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Row
                </Button>
                <div className="grid grid-cols-2 gap-4 border-t pt-2">
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground uppercase">Total DR</div>
                    <div className="font-bold font-mono">{formatAmount(drTotal)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground uppercase">Total CR</div>
                    <div className="font-bold font-mono">{formatAmount(crTotal)}</div>
                  </div>
                </div>
                {!totalsMatch && drTotal > 0 && crTotal > 0 && (
                  <div className="text-xs text-destructive text-center font-medium">
                    Difference: {formatAmount(Math.abs(drTotal - crTotal))}
                  </div>
                )}
              </div>
            </div>

            <div className="hidden md:block border rounded-md overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted/50 sticky top-0 z-30">
                  <tr>
                    <th className="text-left p-3 font-medium w-[10%]">Type</th>
                    <th className="text-left p-3 font-medium w-[35%]">Account</th>
                    <th className="text-left p-3 font-medium w-[25%]">Narration</th>
                    <th className="text-left p-3 font-medium w-[25%]">Amount</th>
                    <th className="w-[5%]"></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => (
                    <tr key={field.id} className="border-t">
                      <td className="p-2">
                        <FormField
                          control={form.control}
                          name={`entries.${index}.type`}
                          render={({ field }) => (
                            <FormItem>
                              <Select onValueChange={field.onChange} value={field.value}>
                                <FormControl>
                                  <SelectTrigger data-testid={`select-type-${index}`}>
                                    <SelectValue placeholder="Type" />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectItem value="DR">DR</SelectItem>
                                  <SelectItem value="CR">CR</SelectItem>
                                </SelectContent>
                              </Select>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </td>
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
                          name={`entries.${index}.narration`}
                          render={({ field }) => (
                            <FormItem>
                              <FormControl>
                                <Input
                                  {...field}
                                  value={field.value ?? ""}
                                  placeholder="Optional note…"
                                  data-testid={`input-narration-journal-${index}`}
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
                        {fields.length > 2 && (
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
                    <td colSpan={3} className="p-3">
                      <div className="flex items-center gap-4">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            append({
                              type: "DR",
                              accountType: "ledger",
                              accountId: 0,
                              accountName: "",
                              amount: "",
                              narration: "",
                            })
                          }
                          data-testid="button-add-row"
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          Add Row
                        </Button>
                        {!totalsMatch && drTotal > 0 && crTotal > 0 && (
                          <span className="text-sm text-destructive font-medium">
                            Difference: {formatAmount(Math.abs(drTotal - crTotal))}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3">
                      <div className="grid grid-cols-1 gap-1">
                        <div className="flex justify-between items-center text-sm">
                          <span className="text-muted-foreground uppercase text-[10px] font-bold">DR:</span>
                          <span className="font-mono font-bold">{formatAmount(drTotal)}</span>
                        </div>
                        <div className="flex justify-between items-center text-sm border-t pt-1">
                          <span className="text-muted-foreground uppercase text-[10px] font-bold">CR:</span>
                          <span className="font-mono font-bold">{formatAmount(crTotal)}</span>
                        </div>
                      </div>
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
              <Button type="submit" disabled={isPending || !totalsMatch} data-testid="button-save-changes">
                {isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
