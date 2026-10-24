import type { AccountingForm, AccountingFormSubmit, AccountingFormValues } from "../types";
/**
 * StockGroupForm — extracted sub-component.
 *
 * Extracted from AccountingCreate.tsx during the Phase 4 god-file split.
 */
import { CreateFormShell } from "./CreateFormShell";
import { FolderTree } from "lucide-react";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { FormButtons } from "./FormButtons";

export // Stock Group Form Component
function StockGroupForm({
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
    <CreateFormShell icon={FolderTree} title="New stock group" description="Organize stock items into an easy-to-find group.">
      <Form {...form}>
        <form
          noValidate
          onSubmit={form.handleSubmit((data: AccountingFormValues) => onSubmit(data, false))}
          className="space-y-6"
        >
          <div className="grid grid-cols-1 gap-x-5 gap-y-6 md:grid-cols-2">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name *</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. Cotton Bales" maxLength={50} data-testid="input-name" />
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

          <p className="text-xs text-muted-foreground">The stock group code will match the name automatically (up to 50 characters).</p>
          <FormButtons onCancel={onCancel} isPending={isPending} submitLabel="Create group" />
        </form>
      </Form>
    </CreateFormShell>
  );
}

// Stock Item Form Component
