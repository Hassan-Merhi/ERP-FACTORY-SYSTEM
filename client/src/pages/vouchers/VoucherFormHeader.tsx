import { format } from "date-fns";
import { FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { UseFormReturn } from "react-hook-form";
import type { VoucherFormData } from "./voucherTypes";

interface VoucherFormHeaderProps {
  form: UseFormReturn<VoucherFormData>;
  voucherNumber?: string;
  title: string;
  description?: string;
  isJournal?: boolean;
}

export function VoucherFormHeader({
  form,
  voucherNumber,
  title,
  description,
  isJournal = false,
}: VoucherFormHeaderProps) {
  return (
    <div className="space-y-4 mb-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {voucherNumber && <p className="text-sm font-mono text-muted-foreground">#{voucherNumber}</p>}
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
        <div className="flex items-center gap-6">
          <FormField
            control={form.control}
            name="optional"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center space-x-2 space-y-0">
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} data-testid="input-optional" />
                </FormControl>
                <Label className="text-sm font-normal cursor-pointer">Optional</Label>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="voucherDate"
            render={({ field }) => (
              <FormItem className="flex items-center gap-2 space-y-0">
                <FormLabel className="text-sm text-muted-foreground shrink-0">Date</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    value={
                      field.value instanceof Date
                        ? format(field.value, "yyyy-MM-dd")
                        : typeof field.value === "string"
                          ? field.value
                          : ""
                    }
                    onChange={(e) =>
                      field.onChange(e.target.value ? new Date(e.target.value + "T00:00:00") : new Date())
                    }
                    className="w-[180px]"
                    data-testid="input-voucher-date"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </div>

      {!isJournal && (
        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-sm">Narration / Notes</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  placeholder="Enter narration for this voucher..."
                  className="resize-none min-h-[80px]"
                  data-testid="input-voucher-notes"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </div>
  );
}
