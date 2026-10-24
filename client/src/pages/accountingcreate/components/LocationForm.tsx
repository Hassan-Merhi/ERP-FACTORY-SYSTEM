import type { AccountingForm, AccountingFormSubmit } from "../types";
/**
 * LocationForm — extracted sub-component.
 *
 * Extracted from AccountingCreate.tsx during the Phase 4 god-file split.
 */
import { CreateFormShell } from "./CreateFormShell";
import { MapPin } from "lucide-react";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { FormButtons } from "./FormButtons";

export // Location Form Component
function LocationForm({
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

  return (
    <CreateFormShell icon={MapPin} title="New location" description="Add a warehouse, shop, or storage location to your current company.">
      <Form {...form}>
        <form noValidate onSubmit={form.handleSubmit((data) => onSubmit(data))} className="space-y-6">
          <div className="grid grid-cols-1 gap-x-5 gap-y-6 md:grid-cols-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name *</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. Main Warehouse" data-testid="input-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />


          </div>

          <p className="text-xs text-muted-foreground">This location will automatically belong to your current company.</p>
          <FormButtons onCancel={onCancel} isPending={isPending} submitLabel="Create location" />
        </form>
      </Form>
    </CreateFormShell>
  );
}

// Ledger Account Form Component
