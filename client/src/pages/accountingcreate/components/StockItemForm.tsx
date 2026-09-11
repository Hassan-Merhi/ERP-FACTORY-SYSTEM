import type { AccountingForm, AccountingFormSubmit, AccountingFormValues, StockGroupOption } from "../types";
/**
 * StockItemForm — extracted sub-component.
 *
 * Extracted from AccountingCreate.tsx during the Phase 4 god-file split.
 */
import { useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useQuery } from "@tanstack/react-query";
import { formatNumber } from "@/lib/formatNumber";

import { FormButtons } from "./FormButtons";

export // Stock Item Form Component
function StockItemForm({
  form,
  onSubmit,
  onCancel,
  isPending,
}: {
  form: AccountingForm;
  onSubmit: AccountingFormSubmit;
  onCancel: () => void;
  isPending: boolean;
}) {
  const { data: stockGroups = [] } = useQuery<StockGroupOption[]>({
    queryKey: ["/api/stock-groups"],
  });

  const openingQty = form.watch("openingQty");
  const openingRate = form.watch("openingRate");

  // Auto-calculate opening value
  useEffect(() => {
    if (openingQty && openingRate) {
      const value = formatNumber(parseFloat(openingQty) * parseFloat(openingRate));
      form.setValue("openingValue", value);
    }
  }, [form, openingQty, openingRate]);

  return (
    <Card className="p-4 md:p-6">
      <Form {...form}>
        <form
          noValidate
          onSubmit={form.handleSubmit((data: AccountingFormValues) => onSubmit(data, false))}
          className="space-y-6"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Code *</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="ITEM001" data-testid="input-code" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name *</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Premium Cotton Bale" data-testid="input-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="stockGroupId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Stock Group</FormLabel>
                  <Select
                    onValueChange={(v) => field.onChange(v ? parseInt(v) : undefined)}
                    value={field.value?.toString() || ""}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="select-stock-group">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {stockGroups.map((grp) => (
                        <SelectItem key={grp.id} value={grp.id.toString()}>
                          {grp.name} ({grp.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="uom"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Unit of Measure *</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Kg, Pcs, Bale" data-testid="input-uom" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="openingQty"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Opening Quantity</FormLabel>
                  <FormControl>
                    <Input {...field} type="number" step="0.001" placeholder="0.000" data-testid="input-opening-qty" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="openingRate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Opening Rate</FormLabel>
                  <FormControl>
                    <Input {...field} type="number" step="0.01" placeholder="0.00" data-testid="input-opening-rate" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="openingValue"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Opening Value (Auto)</FormLabel>
                  <FormControl>
                    <Input {...field} readOnly className="bg-muted" data-testid="input-opening-value" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="reorderLevel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reorder Level</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="number"
                      step="0.001"
                      placeholder="10.000"
                      data-testid="input-reorder-level"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="sellingPrice"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Selling Price</FormLabel>
                  <FormControl>
                    <Input {...field} type="number" step="0.01" placeholder="0.00" data-testid="input-selling-price" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="active"
              render={({ field }) => (
                <FormItem className="flex items-center gap-2 space-y-0 pt-8">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} data-testid="checkbox-active" />
                  </FormControl>
                  <FormLabel className="!mt-0">Active</FormLabel>
                </FormItem>
              )}
            />
          </div>

          <FormButtons onCancel={onCancel} isPending={isPending} />
        </form>
      </Form>
    </Card>
  );
}

// Reusable Form Buttons Component
