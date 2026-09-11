import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Plus, X, CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { CurrencySelector } from "@/components/CurrencySelector";
import type { Currency } from "@/contexts/CurrencyContext";
import { formatNumber } from "@/lib/formatNumber";
import { StockItem, StockItemCombobox } from "./VoucherEditHelpers";
import { PurchaseEditFormTable } from "./PurchaseEditFormTable";
import { AdjustmentEditFormRows } from "./AdjustmentEditFormRows";
import { TransferEditForm } from "./TransferEditForm";

export interface EditLineItem {
  stockItemId: number;
  stockItemName: string;
  quantity: string;
  rate: string;
}

interface EditFormValues {
  voucherDate: Date;
  currency: Currency;
  locationId?: number;
  items: EditLineItem[];
  notes: string;
}

interface OptionalVoucher {
  optional: boolean;
}

interface LocationOption {
  id: number;
  name: string;
}

interface OptionalMutation {
  isPending: boolean;
  mutate: (checked: boolean) => void;
}

export function PurchaseEditForm({
  form,
  onSubmit,
  onCancel,
  isPending,
  voucher,
  stockItems,
  formatDisplayDate,
  formatAmount,
  total,
  toggleOptionalMutation,
}: {
  form: UseFormReturn<EditFormValues>;
  onSubmit: (data: EditFormValues) => void;
  onCancel: () => void;
  isPending: boolean;
  voucher: OptionalVoucher;
  stockItems: StockItem[];
  formatDisplayDate: (date: Date) => string;
  formatAmount: (amount: number) => string;
  total: number;
  toggleOptionalMutation: OptionalMutation;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Purchase Voucher</CardTitle>
        <CardDescription>Update purchase invoice details and line items</CardDescription>
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

            <div className="flex items-center gap-2 py-2 border-y">
              <Switch
                id="optional-toggle-purchase"
                checked={voucher.optional}
                onCheckedChange={(checked) => toggleOptionalMutation.mutate(checked)}
                disabled={toggleOptionalMutation.isPending}
                data-testid="switch-optional"
              />
              <Label htmlFor="optional-toggle-purchase" className="cursor-pointer">
                Optional (Does not affect books)
              </Label>
            </div>

            <div>
              <FormLabel className="mb-2 block">Line Items</FormLabel>
              <div className="md:hidden space-y-3">
                {fields.map((field, index) => {
                  const qty = parseFloat(form.watch(`items.${index}.quantity`)) || 0;
                  const rate = parseFloat(form.watch(`items.${index}.rate`)) || 0;
                  const lineTotal = qty * rate;
                  return (
                    <div key={field.id} className="border rounded-md p-3 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-muted-foreground">Item {index + 1}</span>
                        {fields.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => remove(index)}
                            data-testid={`button-remove-purchase-mobile-${index}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                      <FormField
                        control={form.control}
                        name={`items.${index}.stockItemId`}
                        render={({ field: _itemField }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Stock Item</FormLabel>
                            <FormControl>
                              <StockItemCombobox
                                value={
                                  form.watch(`items.${index}.stockItemId`) > 0
                                    ? {
                                        id: form.watch(`items.${index}.stockItemId`),
                                        name: form.watch(`items.${index}.stockItemName`),
                                      }
                                    : null
                                }
                                onChange={(id, name) => {
                                  form.setValue(`items.${index}.stockItemId`, id);
                                  form.setValue(`items.${index}.stockItemName`, name);
                                }}
                                stockItems={stockItems}
                                rowIndex={index}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <FormField
                          control={form.control}
                          name={`items.${index}.quantity`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">Quantity</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  type="number"
                                  step="0.001"
                                  placeholder="0"
                                  className="font-mono"
                                  data-testid={`input-quantity-purchase-mobile-${index}`}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`items.${index}.rate`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">Rate</FormLabel>
                              <FormControl>
                                <Input
                                  {...field}
                                  type="number"
                                  step="0.01"
                                  placeholder="0.00"
                                  className="font-mono"
                                  data-testid={`input-rate-purchase-mobile-${index}`}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                      <div className="flex items-center justify-between pt-2 border-t">
                        <span className="text-sm text-muted-foreground">Total</span>
                        <span className="font-mono font-medium" data-testid={`text-total-purchase-mobile-${index}`}>
                          {formatAmount(lineTotal)}
                        </span>
                      </div>
                    </div>
                  );
                })}
                <div className="flex items-center justify-between gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => append({ stockItemId: 0, stockItemName: "", quantity: "", rate: "" })}
                    data-testid="button-add-row-purchase-mobile"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Row
                  </Button>
                  <div className="text-right">
                    <div className="text-sm text-muted-foreground">Grand Total</div>
                    <div className="font-bold font-mono">{formatAmount(total)}</div>
                  </div>
                </div>
              </div>

              <PurchaseEditFormTable
                fields={fields}
                append={append}
                remove={remove}
                stockItems={stockItems}
                formatAmount={formatAmount}
                total={total}
              />

              <div className="hidden md:flex justify-end p-2 bg-muted/30 border-x border-b rounded-b-md">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium">Total Quantity:</span>
                  <span className="font-mono font-medium">
                    {formatNumber(
                      form.watch("items").reduce((sum: number, item: { quantity: string }) => sum + (parseFloat(item.quantity) || 0), 0)
                    )}
                  </span>
                </div>
              </div>
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

export function AdjustmentEditForm({
  form,
  voucherType,
  onSubmit,
  onCancel,
  isPending,
  voucher,
  stockItems,
  locations,
  formatDisplayDate,
  formatAmount,
  total,
  toggleOptionalMutation,
}: {
  form: UseFormReturn<EditFormValues>;
  voucherType: string;
  onSubmit: (data: EditFormValues) => void;
  onCancel: () => void;
  isPending: boolean;
  voucher: OptionalVoucher;
  stockItems: StockItem[];
  locations: LocationOption[];
  formatDisplayDate: (date: Date) => string;
  formatAmount: (amount: number) => string;
  total: number;
  toggleOptionalMutation: OptionalMutation;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });
  const location = locations.find((l) => l.id === form.watch("locationId"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit {voucherType} Voucher</CardTitle>
        <CardDescription>Update stock adjustment details and line items</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="voucherDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
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
              <div className="flex-1">
                <FormLabel>Location</FormLabel>
                <Input value={location?.name || "N/A"} disabled className="mt-2" data-testid="input-location" />
                <p className="text-xs text-muted-foreground mt-1">Location cannot be changed</p>
              </div>
            </div>

            <div className="flex items-center gap-2 py-2 border-y">
              <Switch
                id="optional-toggle-adjustment"
                checked={voucher.optional}
                onCheckedChange={(checked) => toggleOptionalMutation.mutate(checked)}
                disabled={toggleOptionalMutation.isPending}
                data-testid="switch-optional"
              />
              <Label htmlFor="optional-toggle-adjustment" className="cursor-pointer">
                Optional (Does not affect books)
              </Label>
            </div>

            <div>
              <FormLabel className="mb-2 block">Line Items</FormLabel>
              <div className="md:hidden space-y-3">
                {fields.map((field, index) => {
                  const qty = parseFloat(form.watch(`items.${index}.quantity`)) || 0;
                  const rate = parseFloat(form.watch(`items.${index}.rate`)) || 0;
                  const lineTotal = qty * rate;
                  return (
                    <div key={field.id} className="border rounded-md p-3 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-muted-foreground">Item {index + 1}</span>
                        {fields.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => remove(index)}
                            data-testid={`button-remove-adj-mobile-${index}`}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                      <StockItemCombobox
                        value={
                          form.watch(`items.${index}.stockItemId`) > 0
                            ? {
                                id: form.watch(`items.${index}.stockItemId`),
                                name: form.watch(`items.${index}.stockItemName`),
                              }
                            : null
                        }
                        onChange={(id, name) => {
                          form.setValue(`items.${index}.stockItemId`, id);
                          form.setValue(`items.${index}.stockItemName`, name);
                        }}
                        stockItems={stockItems}
                        rowIndex={index}
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <Input
                          {...form.register(`items.${index}.quantity`)}
                          type="number"
                          step="0.001"
                          placeholder="Qty"
                          data-testid={`input-quantity-adj-mobile-${index}`}
                        />
                        <Input
                          {...form.register(`items.${index}.rate`)}
                          type="number"
                          step="0.01"
                          placeholder="Rate"
                          data-testid={`input-rate-adj-mobile-${index}`}
                        />
                      </div>
                      <div className="flex items-center justify-between pt-2 border-t">
                        <span className="text-sm text-muted-foreground">Total</span>
                        <span className="font-mono font-medium">{formatAmount(lineTotal)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <AdjustmentEditFormRows
                fields={fields}
                append={append}
                remove={remove}
                stockItems={stockItems}
                formatAmount={formatAmount}
              />

              <div className="hidden md:flex justify-end p-2 bg-muted/30 border-x border-b rounded-b-md">
                <div className="flex items-center gap-4">
                  <span className="text-sm font-medium">Grand Total:</span>
                  <span className="font-bold font-mono">{formatAmount(total)}</span>
                </div>
              </div>
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

export { TransferEditForm };
