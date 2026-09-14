import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { CalendarIcon, Plus, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { Voucher } from "@shared/schema";
import {
  voucherSchema,
  type VoucherEntry,
  type VoucherFormData,
  type LedgerAccount,
  type BankAccount,
  type Supplier,
  type Employee,
  type FixedAsset,
} from "./vouchers/voucherEditSchema";
import {
  emptyVoucherEntry,
  voucherDataToFormValues,
  voucherFormToPayload,
  computeEntryTotals,
  parseConsumptionNarration,
  parseConsumptionNarrationQty,
} from "./vouchers/voucherEditMapping";
import { VoucherEntryRow } from "./vouchers/VoucherEntryRow";

// Types
interface VoucherEditDialogProps {
  voucherId: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function VoucherEditDialog({ voucherId, open, onOpenChange }: VoucherEditDialogProps) {
  const { toast } = useToast();
  const { formatHistoricalBaseAmount: formatAmount } = useCurrencyContext();
  const { formatDisplayDate } = useDateFormat();
  const [showOptionalWarning, setShowOptionalWarning] = useState(false);

  // Fetch reference data
  const { data: ledgerAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts"],
    enabled: open,
  });
  const { data: bankAccounts = [] } = useQuery<BankAccount[]>({
    queryKey: ["/api/bank-accounts"],
    enabled: open,
  });
  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers"],
    enabled: open,
  });
  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees"],
    enabled: open,
  });
  const { data: fixedAssets = [] } = useQuery<FixedAsset[]>({
    queryKey: ["/api/fixed-assets"],
    enabled: open,
  });

  // Fetch voucher data
  const { data: voucherData, isLoading } = useQuery<Voucher & { entries?: VoucherEntry[] }>({
    queryKey: ["/api/vouchers", voucherId],
    enabled: open && !!voucherId,
  });

  const form = useForm<VoucherFormData>({
    resolver: zodResolver(voucherSchema),
    defaultValues: {
      voucherNumber: "",
      voucherType: "Journal",
      voucherDate: new Date(),
      description: "",
      optional: false,
      entries: [emptyVoucherEntry],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "entries",
  });

  // Load voucher data into form
  useEffect(() => {
    if (voucherData && open) {
      form.reset(voucherDataToFormValues(voucherData));
    }
  }, [voucherData, open, form]);

  const updateMutation = useMutation({
    mutationFn: async (data: VoucherFormData) => {
      if (!voucherId) throw new Error("Voucher ID is required");

      return await apiRequest("PUT", `/api/vouchers/${voucherId}/with-entries`, voucherFormToPayload(data));
    },
    onSuccess: () => {
      toast({
        title: "Success",
        description: "Voucher updated successfully",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: VoucherFormData) => {
    const { totalDebits, totalCredits } = computeEntryTotals(data.entries);

    // Show warning for optional vouchers with mismatched debits/credits
    if (data.optional && Math.abs(totalDebits - totalCredits) >= 0.01) {
      setShowOptionalWarning(true);
    } else {
      setShowOptionalWarning(false);
    }

    updateMutation.mutate(data);
  };

  // Calculate totals
  const entries = form.watch("entries");
  const { totalDebits, totalCredits, isBalanced } = computeEntryTotals(entries);
  const isOptional = form.watch("optional");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Voucher</DialogTitle>
          <DialogDescription>
            Modify voucher details and entries. {!isOptional && "Debits must equal credits for active vouchers."}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="text-center py-8">Loading voucher data...</div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
              {/* Voucher Header */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <FormField
                  control={form.control}
                  name="voucherNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Voucher Number</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-voucher-number" disabled />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="voucherType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger data-testid="select-voucher-type">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Payment">Payment</SelectItem>
                          <SelectItem value="Receipt">Receipt</SelectItem>
                          <SelectItem value="Journal">Journal</SelectItem>
                          <SelectItem value="Sales">Sales</SelectItem>
                          <SelectItem value="Purchase">Purchase</SelectItem>
                          <SelectItem value="Contra">Contra</SelectItem>
                          <SelectItem value="Stock Transfer">Stock Transfer</SelectItem>
                        </SelectContent>
                      </Select>
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
                                "w-full pl-3 text-left font-normal",
                                !field.value && "text-muted-foreground"
                              )}
                              data-testid="button-select-date"
                            >
                              {field.value ? formatDisplayDate(field.value) : "Pick a date"}
                              <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
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
              </div>

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Description</FormLabel>
                    <FormControl>
                      <Textarea {...field} data-testid="input-description" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="optional"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-edit-optional"
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel className="font-medium">Mark as Optional (non-posting)</FormLabel>
                    </div>
                  </FormItem>
                )}
              />

              {/* Voucher Entries */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-medium">Voucher Entries</h3>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => append({ ...emptyVoucherEntry })}
                    data-testid="button-add-entry"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Entry
                  </Button>
                </div>

                <div className="table-responsive">
                  <table className="w-full text-sm">
                    <thead className="border-b sticky top-0 z-30">
                      <tr>
                        {form.watch("voucherType") === "Consumption" || form.watch("voucherType") === "Production" ? (
                          <>
                            <th className="text-left py-2 px-2 w-[40%]">Item Name</th>
                            <th className="text-right py-2 px-2 w-[15%]">Qty</th>
                            <th className="text-right py-2 px-2 w-[15%]">Amount</th>
                            <th className="text-right py-2 px-2 w-[20%]">Total Amount</th>
                          </>
                        ) : (
                          <>
                            <th className="text-left py-2 px-2 w-[60%]">Account</th>
                            {form.watch("voucherType") === "Payment" || form.watch("voucherType") === "Receipt" ? (
                              <th className="text-right py-2 px-2 w-[35%]">Amount</th>
                            ) : (
                              <>
                                <th className="text-right py-2 px-2 w-[15%]">Debit</th>
                                <th className="text-right py-2 px-2 w-[15%]">Credit</th>
                                <th className="text-left py-2 px-2 w-[20%]">Narration</th>
                              </>
                            )}
                          </>
                        )}
                        <th className="text-center py-2 px-2 w-[5%]"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map((field, index) => (
                        <VoucherEntryRow
                          key={field.id}
                          form={form}
                          field={field}
                          index={index}
                          fieldsLength={fields.length}
                          remove={remove}
                          ledgerAccounts={ledgerAccounts}
                          bankAccounts={bankAccounts}
                          suppliers={suppliers}
                          employees={employees}
                          fixedAssets={fixedAssets}
                          formatAmount={formatAmount}
                        />
                      ))}
                    </tbody>
                    <tfoot className="border-t-2 font-semibold">
                      <tr>
                        {form.watch("voucherType") === "Consumption" || form.watch("voucherType") === "Production" ? (
                          <>
                            <td className="py-2 px-2 text-right">Total:</td>
                            <td className="py-2 px-2 text-right font-mono">
                              {fields
                                .reduce((sum, _, index) => {
                                  const narration = form.watch(`entries.${index}.narration`) || "";
                                  return sum + (parseConsumptionNarrationQty(narration) ?? 0);
                                }, 0)
                                .toFixed(3)}
                            </td>
                            <td className="py-2 px-2"></td>
                            <td className="py-2 px-2 text-right font-mono">
                              {formatAmount(
                                fields.reduce((sum, _, index) => {
                                  const narration = form.watch(`entries.${index}.narration`) || "";
                                  const parsed = parseConsumptionNarration(narration);
                                  return parsed ? sum + parsed.qty * parsed.rate : sum;
                                }, 0)
                              )}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="py-2 px-2 text-right">Total:</td>
                            {form.watch("voucherType") === "Payment" || form.watch("voucherType") === "Receipt" ? (
                              <>
                                <td className="py-2 px-2 text-right font-mono" data-testid="text-total-amount">
                                  {formatAmount(Math.max(totalDebits, totalCredits))}
                                </td>
                                <td className="py-2 px-2"></td>
                              </>
                            ) : (
                              <>
                                <td className="py-2 px-2 text-right font-mono" data-testid="text-total-debits">
                                  {formatAmount(totalDebits)}
                                </td>
                                <td className="py-2 px-2 text-right font-mono" data-testid="text-total-credits">
                                  {formatAmount(totalCredits)}
                                </td>
                                <td colSpan={2} className="py-2 px-2">
                                  {!isBalanced && !isOptional && (
                                    <div className="flex items-center gap-2 text-destructive text-sm">
                                      <AlertTriangle className="h-4 w-4" />
                                      Debits must equal credits
                                    </div>
                                  )}
                                  {!isBalanced && isOptional && showOptionalWarning && (
                                    <div className="flex items-center gap-2 text-amber-500 text-sm">
                                      <AlertTriangle className="h-4 w-4" />
                                      Optional – not posted to ledgers
                                    </div>
                                  )}
                                  {isBalanced && <div className="text-sm text-muted-foreground">Balanced</div>}
                                </td>
                              </>
                            )}
                          </>
                        )}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel">
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={updateMutation.isPending || (!isBalanced && !isOptional)}
                  data-testid="button-save"
                >
                  {updateMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
