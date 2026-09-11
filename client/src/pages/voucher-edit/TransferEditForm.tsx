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
import { StockItemCombobox, StockItem, Location, VoucherData } from "./VoucherEditHelpers";
import type { TransferFormData } from "./VoucherEditSchemas";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/formatNumber";

export function TransferEditForm({
  form,
  voucher,
  onSubmit,
  onCancel,
  onToggleOptional,
  isPending,
  isTogglingOptional,
  stockItems,
  locations,
  formatDisplayDate,
  formatAmount,
  grandTotal,
}: {
  form: UseFormReturn<TransferFormData>;
  voucher: VoucherData;
  onSubmit: (data: TransferFormData) => void;
  onCancel: () => void;
  onToggleOptional: (optional: boolean) => void;
  isPending: boolean;
  isTogglingOptional: boolean;
  stockItems: StockItem[];
  locations: Location[];
  formatDisplayDate: (date: Date) => string;
  formatAmount: (amount: number) => string;
  grandTotal: number;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const sourceLocation = locations.find((l) => l.id === form.getValues("sourceLocationId"));
  const destinationLocation = locations.find((l) => l.id === form.getValues("destinationLocationId"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Stock Transfer Voucher</CardTitle>
        <CardDescription>Update stock transfer details and line items</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                              "w-full justify-start text-left font-normal",
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
                <Label className="text-sm font-medium">Source Location</Label>
                <Input
                  value={sourceLocation?.name || "N/A"}
                  disabled
                  className="mt-2"
                  data-testid="input-source-location"
                />
              </div>

              <div className="flex-1">
                <Label className="text-sm font-medium">Destination Location</Label>
                <Input
                  value={destinationLocation?.name || "N/A"}
                  disabled
                  className="mt-2"
                  data-testid="input-destination-location"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 py-2 border-y">
              <Switch
                id="optional-toggle-transfer"
                checked={voucher.optional}
                onCheckedChange={onToggleOptional}
                disabled={isTogglingOptional}
                data-testid="switch-optional"
              />
              <Label htmlFor="optional-toggle-transfer" className="cursor-pointer">
                Optional (Does not affect books)
              </Label>
            </div>

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
                          data-testid={`button-remove-transfer-mobile-${index}`}
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
                                data-testid={`input-quantity-transfer-mobile-${index}`}
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
                                data-testid={`input-rate-transfer-mobile-${index}`}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t">
                      <span className="text-sm text-muted-foreground">Total</span>
                      <span className="font-mono font-medium" data-testid={`text-total-transfer-mobile-${index}`}>
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
                  data-testid="button-add-row-transfer-mobile"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Row
                </Button>
                <div className="text-right">
                  <div className="text-sm text-muted-foreground">Grand Total</div>
                  <div className="font-bold font-mono">{formatAmount(grandTotal)}</div>
                </div>
              </div>
            </div>

            <div className="hidden md:block border rounded-md overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted/50 sticky top-0 z-30">
                  <tr>
                    <th className="text-left p-3 font-medium w-[40%]">Stock Item</th>
                    <th className="text-left p-3 font-medium w-[15%]">Quantity</th>
                    <th className="text-left p-3 font-medium w-[15%]">Rate</th>
                    <th className="text-right p-3 font-medium w-[25%]">Total</th>
                    <th className="w-[5%]"></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => {
                    const qty = parseFloat(form.watch(`items.${index}.quantity`)) || 0;
                    const rate = parseFloat(form.watch(`items.${index}.rate`)) || 0;
                    const lineTotal = qty * rate;

                    return (
                      <tr key={field.id} className="border-t">
                        <td className="p-2">
                          <FormField
                            control={form.control}
                            name={`items.${index}.stockItemId`}
                            render={({ field: _itemField }) => (
                              <FormItem>
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
                        </td>
                        <td className="p-2">
                          <FormField
                            control={form.control}
                            name={`items.${index}.quantity`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <Input
                                    {...field}
                                    type="number"
                                    step="0.001"
                                    placeholder="0"
                                    className="font-mono"
                                    data-testid={`input-quantity-${index}`}
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
                            name={`items.${index}.rate`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <Input
                                    {...field}
                                    type="number"
                                    step="0.01"
                                    placeholder="0.00"
                                    className="font-mono"
                                    data-testid={`input-rate-${index}`}
                                  />
                                </FormControl>
                                <FormMessage />
                              </FormItem>
                            )}
                          />
                        </td>
                        <td className="p-2">
                          <div className="text-right font-mono font-medium" data-testid={`text-total-${index}`}>
                            {formatAmount(lineTotal)}
                          </div>
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
                    );
                  })}
                </tbody>
                <tfoot className="bg-muted/30 border-t-2">
                  <tr>
                    <td colSpan={3} className="p-3">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          append({
                            stockItemId: 0,
                            stockItemName: "",
                            quantity: "",
                            rate: "",
                          })
                        }
                        data-testid="button-add-row"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Add Row
                      </Button>
                    </td>
                    <td className="p-3">
                      <div className="text-right font-bold font-mono" data-testid="text-grand-total">
                        {formatAmount(grandTotal)}
                      </div>
                    </td>
                    <td></td>
                  </tr>
                  <tr className="border-t">
                    <td className="p-3 text-right font-medium" colSpan={1}>
                      Total Quantity:
                    </td>
                    <td className="p-3 font-mono font-medium">
                      {formatNumber(
                        form
                          .watch("items")
                          .reduce((sum: number, item: { quantity: string }) => sum + (parseFloat(item.quantity) || 0), 0)
                      )}
                    </td>
                    <td colSpan={3}></td>
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
              <Button type="submit" disabled={isPending || grandTotal === 0} data-testid="button-save-changes">
                {isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
