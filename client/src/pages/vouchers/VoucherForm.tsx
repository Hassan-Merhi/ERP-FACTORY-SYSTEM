import { format } from "date-fns";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { UseFormReturn } from "react-hook-form";
import type { VoucherFormData } from "./voucherTypes";
import { Loader2 } from "lucide-react";

interface VoucherFormProps {
  form: UseFormReturn<VoucherFormData>;
  onSubmit: (data: Record<string, unknown>) => void;
  isPending: boolean;
  voucherNumber?: string;
  title: string;
  children?: React.ReactNode;
  footerActions?: React.ReactNode;
}

export function VoucherForm({
  form,
  onSubmit,
  isPending,
  voucherNumber,
  title,
  children,
  footerActions,
}: VoucherFormProps) {
  return (
    <Card className="flex-1 min-w-0">
      <CardContent className="pt-5">
        <div className="flex items-center gap-2 mb-5">
          <span className="text-sm font-semibold">{title}</span>
        </div>
        <Form {...form}>
          <form noValidate onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold">{voucherNumber ? `#${voucherNumber}` : "New Entry"}</p>
              </div>
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

            {children}

            <div className="flex items-center justify-end gap-3 pt-4 border-t">
              {footerActions}
              <Button type="submit" disabled={isPending} className="min-w-[120px]">
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save Voucher"
                )}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
