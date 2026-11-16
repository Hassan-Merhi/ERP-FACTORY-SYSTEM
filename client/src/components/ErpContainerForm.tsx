// Extracted from ./AddContainerDialog.tsx to keep that module under the source-size cap.
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { insertContainerSchema } from "@shared/schema";

// ── ERP schema (unchanged) ───────────────────────────────────────────────────
const erpFormSchema = insertContainerSchema
  .pick({
    containerNumber: true,
    supplierId: true,
    status: true,
    importDate: true,
  })
  .extend({
    status: z.string().default("AVAILABLE"),
    itemName: z.string().min(1, "Item name is required"),
    ratePerKg: z.coerce.number().positive("Rate must be positive"),
    totalKg: z.coerce.number().positive("Weight must be positive"),
  });

// ── SP schema ────────────────────────────────────────────────────────────────
const spLineSchema = z.object({
  articleCode: z.string().min(1, "Required"),
  description: z.string().optional(),
  qty: z.string().min(1, "Required"),
  unitRateUsd: z.string().min(1, "Required"),
  /** Stock item resolved from the Excel barcode or alias; manual lines leave it empty. */
  stockItemId: z.number().nullable().optional(),
});

export const spFormSchema = z.object({
  supplierId: z.number().optional(),
  supplierName: z.string().min(1, "Required"),
  containerNumber: z.string().optional(),
  invoiceNumber: z.string().min(1, "Required"),
  invoiceDate: z.string().min(1, "Required"),
  invoiceTotalUsd: z.string().min(1, "Required"),
  discountPct: z.string().optional(),
  freightEstimateUsd: z.string().optional(),
  surchargeUsd: z.string().optional(),
  fumigationUsd: z.string().optional(),
  documentChargesUsd: z.string().optional(),
  notes: z.string().optional(),
  lines: z.array(spLineSchema).min(1, "Add at least one line item"),
});

type ErpForm = z.infer<typeof erpFormSchema>;

export type SpForm = z.infer<typeof spFormSchema>;

export function fmt2(v: unknown) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? "$0.00" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface ErpSupplierOption {
  id: number;
  legalName: string;
}

// ── ERP form (completely unchanged logic) ────────────────────────────────────
export function ErpContainerForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();

  const { data: suppliers } = useQuery<ErpSupplierOption[]>({
    queryKey: ["/api/suppliers"],
  });

  const form = useForm<ErpForm>({
    resolver: zodResolver(erpFormSchema),
    defaultValues: {
      containerNumber: "",
      supplierId: 0,
      status: "AVAILABLE",
      importDate: new Date().toLocaleDateString("en-CA"),
      itemName: "",
      ratePerKg: 0,
      totalKg: 0,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: ErpForm) => {
      const payload = {
        ...data,
        ratePerKg: data.ratePerKg.toString(),
        totalKg: data.totalKg.toString(),
      };
      const response = await fetch("/api/containers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to create container");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
      toast({ title: "Success", description: "Container added successfully" });
      onOpenChange(false);
      form.reset();
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((d) => createMutation.mutate(d))} className="space-y-4" noValidate>
        <FormField
          control={form.control}
          name="containerNumber"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Container Number *</FormLabel>
              <FormControl>
                <Input {...field} placeholder="CONT-001" data-testid="input-container-number" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="supplierId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Supplier *</FormLabel>
              <Select onValueChange={(v) => field.onChange(parseInt(v))} value={field.value?.toString()}>
                <FormControl>
                  <SelectTrigger data-testid="select-supplier">
                    <SelectValue placeholder="Select supplier" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {suppliers?.map((s) => (
                    <SelectItem key={s.id} value={s.id.toString()}>
                      {s.legalName}
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
          name="itemName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Item Name *</FormLabel>
              <FormControl>
                <Input {...field} placeholder="e.g., Used Clothing Mix" data-testid="input-item-name" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="ratePerKg"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Rate ($/kg) *</FormLabel>
                <FormControl>
                  <Input {...field} type="number" step="any" placeholder="0.3600000" data-testid="input-rate-per-kg" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="totalKg"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Total Weight (kg) *</FormLabel>
                <FormControl>
                  <Input {...field} type="number" step="0.01" placeholder="20000" data-testid="input-total-kg" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        {/* Live total value preview */}
        {(() => {
          const rate = parseFloat(String(form.watch("ratePerKg") ?? 0));
          const kg = parseFloat(String(form.watch("totalKg") ?? 0));
          if (!rate || !kg || isNaN(rate) || isNaN(kg)) return null;
          const total = rate * kg;
          return (
            <div
              className="flex items-center justify-between rounded-md bg-muted/50 border px-3 py-2 text-sm"
              data-testid="text-container-value-preview"
            >
              <span className="text-muted-foreground">Estimated total value</span>
              <span className="font-semibold font-mono tabular-nums">
                ${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                <span className="text-xs text-muted-foreground font-normal ml-1.5">
                  ({rate.toLocaleString("en-US", { maximumFractionDigits: 7 })} ×{" "}
                  {kg.toLocaleString("en-US", { maximumFractionDigits: 2 })} kg)
                </span>
              </span>
            </div>
          );
        })()}

        <FormField
          control={form.control}
          name="status"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Status</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger data-testid="select-status">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value="OTW">OTW (On The Way)</SelectItem>
                  <SelectItem value="ARRIVED">Arrived</SelectItem>
                  <SelectItem value="AVAILABLE">Available</SelectItem>
                  <SelectItem value="OFFLOADED">Offloaded</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="importDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Import Date *</FormLabel>
              <FormControl>
                <Input {...field} type="date" data-testid="input-import-date" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel">
            Cancel
          </Button>
          <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit">
            {createMutation.isPending ? "Adding..." : "Add Container"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
