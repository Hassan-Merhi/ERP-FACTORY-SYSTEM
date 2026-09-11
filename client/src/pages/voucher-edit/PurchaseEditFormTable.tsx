import { useFormContext } from "react-hook-form";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormItem, FormControl, FormMessage } from "@/components/ui/form";
import { StockItem, StockItemCombobox } from "./VoucherEditHelpers";
import type { EditLineItem } from "./PurchaseAdjustmentEditForm";

interface PurchaseEditFormTableProps {
  fields: Array<{ id: string }>;
  append: (item: EditLineItem) => void;
  remove: (index: number) => void;
  stockItems: StockItem[];
  formatAmount: (amount: number) => string;
  total: number;
}

export function PurchaseEditFormTable({
  fields,
  append,
  remove,
  stockItems,
  formatAmount,
  total,
}: PurchaseEditFormTableProps) {
  const form = useFormContext();

  return (
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
                <td className="p-2 text-right">
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
                onClick={() => append({ stockItemId: 0, stockItemName: "", quantity: "", rate: "" })}
                data-testid="button-add-row"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Row
              </Button>
            </td>
            <td className="p-3">
              <div className="text-right font-bold font-mono" data-testid="text-grand-total">
                {formatAmount(total)}
              </div>
            </td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
