import type { AccountingForm, AccountingFormSubmit, AccountingFormValues, StockGroupOption } from "../types";
/**
 * StockItemForm — extracted sub-component.
 *
 * Extracted from AccountingCreate.tsx during the Phase 4 god-file split.
 */
import { CreateFormShell } from "./CreateFormShell";
import { Package } from "lucide-react";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useQuery } from "@tanstack/react-query";

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


  return (
    <CreateFormShell icon={Package} title="New stock item" description="Create the item first; stock quantity and cost are recorded when stock is received.">
      <Form {...form}>
        <form
          noValidate
          onSubmit={form.handleSubmit((data: AccountingFormValues) => onSubmit(data, false))}
          className="space-y-6"
        >
          <div className="grid grid-cols-1 gap-x-5 gap-y-6 md:grid-cols-2">
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
                          {grp.name}
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
                    <Input {...field} placeholder="e.g. Pcs, Kg, Bale" data-testid="input-uom" />
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
                  <FormLabel className="mt-0!">Active</FormLabel>
                </FormItem>
              )}
            />
          </div>

          <p className="text-xs text-muted-foreground">Quantity, opening value and reorder settings are not part of item creation. Stock starts at zero.</p>
          <FormButtons onCancel={onCancel} isPending={isPending} submitLabel="Create item" />
        </form>
      </Form>
    </CreateFormShell>
  );
}

// Reusable Form Buttons Component
