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
import type { SalesFormData } from "./VoucherEditSchemas";
import { cn } from "@/lib/utils";

export function SalesEditForm({
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
  form: UseFormReturn<SalesFormData>;
  voucher: VoucherData;
  onSubmit: (data: SalesFormData) => void;
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

  const location = locations.find((l) => l.id === form.getValues("locationId"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit Sales Voucher</CardTitle>
        <CardDescription>Update sales invoice details and line items</CardDescription>
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

              <div className="flex-1">
                <p className="text-sm font-medium leading-none">Location</p>
                <Input value={location?.name || "N/A"} disabled className="mt-2" data-testid="input-location" />
                <p className="text-xs text-muted-foreground mt-1">
                  Location cannot be changed to maintain inventory accuracy
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 py-2 border-y">
              <Switch
                id="optional-toggle-sales"
                checked={voucher.optional}
                onCheckedChange={onToggleOptional}
                disabled={isTogglingOptional}
                data-testid="switch-optional"
              />
              <Label htmlFor="optional-toggle-sales" className="cursor-pointer">
                Optional (Does not affect books)
              </Label>
            </div>

            <div className="md:hidden space-y-3">
              {fields.map((field, index) => {
                const qty = parseFloat(form.watch(`items.${index}.quantity`)) || 0;
                const price = parseFloat(form.watch(`items.${index}.sellingPrice`)) || 0;
                const lineTotal = qty * price;
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
                          data-testid={`button-remove-sales-mobile-${index}`}
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
                                data-testid={`input-quantity-sales-mobile-${index}`}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`items.${index}.sellingPrice`}
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Price</FormLabel>
                            <FormControl>
                              <Input
                                {...field}
                                type="number"
                                step="0.01"
                                placeholder="0.00"
                                className="font-mono"
                                data-testid={`input-price-sales-mobile-${index}`}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <div className="flex items-center justify-between pt-2 border-t">
                      <span className="text-sm text-muted-foreground">Total</span>
                      <span className="font-mono font-medium" data-testid={`text-total-sales-mobile-${index}`}>
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
                  onClick={() => append({ stockItemId: 0, stockItemName: "", quantity: "", sellingPrice: "" })}
                  data-testid="button-add-row-sales-mobile"
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
                    <th className="text-left p-3 font-medium w-[15%]">Price</th>
                    <th className="text-right p-3 font-medium w-[25%]">Total</th>
                    <th className="w-[5%]"></th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map((field, index) => {
                    const qty = parseFloat(form.watch(`items.${index}.quantity`)) || 0;
                    const price = parseFloat(form.watch(`items.${index}.sellingPrice`)) || 0;
                    const lineTotal = qty * price;

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
                            name={`items.${index}.sellingPrice`}
                            render={({ field }) => (
                              <FormItem>
                                <FormControl>
                                  <Input
                                    {...field}
                                    type="number"
                                    step="0.01"
                                    placeholder="0.00"
                                    className="font-mono"
                                    data-testid={`input-price-${index}`}
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
                            sellingPrice: "",
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
