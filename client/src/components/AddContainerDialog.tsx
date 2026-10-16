import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, ClipboardPaste, FileText } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { insertContainerSchema } from "@shared/schema";
import type { SpExcelImportContainer } from "@shared/spContainerExcelImport";
import { SpContainerExcelImport } from "./SpContainerExcelImport";
import { spContainerInvoiceChargesTotal } from "@shared/spContainerInvoiceCharges";

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

const spFormSchema = z.object({
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
type SpForm = z.infer<typeof spFormSchema>;

function fmt2(v: unknown) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n) ? "$0.00" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface ErpSupplierOption {
  id: number;
  legalName: string;
}

interface AddContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSP?: boolean;
}

// ── ERP form (completely unchanged logic) ────────────────────────────────────
function ErpContainerForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
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

// ── SP form ──────────────────────────────────────────────────────────────────
function SpContainerForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast();
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);

  const { data: suppliers = [] } = useQuery<{ id: number; legalName: string; code: string }[]>({
    queryKey: ["/api/suppliers"],
  });

  const form = useForm<SpForm>({
    resolver: zodResolver(spFormSchema),
    defaultValues: {
      supplierId: undefined,
      supplierName: "",
      containerNumber: "",
      invoiceNumber: "",
      invoiceDate: new Date().toISOString().slice(0, 10),
      invoiceTotalUsd: "",
      discountPct: "0",
      freightEstimateUsd: "0",
      surchargeUsd: "0",
      fumigationUsd: "0",
      documentChargesUsd: "0",
      notes: "",
      lines: [{ articleCode: "", description: "", qty: "", unitRateUsd: "", stockItemId: null }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });
  const watchLines = form.watch("lines");
  const watchDiscount = form.watch("discountPct");
  const watchTotal = form.watch("invoiceTotalUsd");

  const watchCharges = form.watch(["freightEstimateUsd", "surchargeUsd", "fumigationUsd", "documentChargesUsd"]);
  const invoiceChargesTotal = spContainerInvoiceChargesTotal({
    freightEstimateUsd: watchCharges[0],
    surchargeUsd: watchCharges[1],
    fumigationUsd: watchCharges[2],
    documentChargesUsd: watchCharges[3],
  });
  const discountFactor = 1 - parseFloat(watchDiscount || "0") / 100;
  const totalBaseCost = watchLines.reduce(
    (s, l) => s + parseFloat(l.qty || "0") * parseFloat(l.unitRateUsd || "0") * discountFactor,
    0
  );
  const invoiceTotal = parseFloat(watchTotal || "0");

  const createMutation = useMutation({
    mutationFn: async (data: SpForm) => {
      const response = await fetch("/api/sp/containers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to create container");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/containers"] });
      toast({
        title: "Container created",
        description: "Goods OTW journal posted: Dr Goods OTW / Cr OTW Clearing",
      });
      onOpenChange(false);
      form.reset();
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const parsePaste = useCallback(() => {
    if (!pasteText.trim()) return;
    const rows = pasteText
      .trim()
      .split("\n")
      .map((r) => r.split("\t").map((c) => c.trim()));
    const parsed = rows
      .filter((r) => r.length >= 3 && r[0])
      .map((r) => ({
        articleCode: r[0] || "",
        description: r.length >= 4 ? r[1] : "",
        qty: r.length >= 4 ? r[2] : r[1],
        unitRateUsd: r.length >= 4 ? r[3] : r[2],
        stockItemId: null,
      }));
    if (parsed.length > 0) {
      form.setValue("lines", parsed);
      setShowPaste(false);
      setPasteText("");
      toast({ title: "Pasted", description: `${parsed.length} line(s) imported` });
    }
  }, [pasteText, form, toast]);

  // Fill the form from the ERP "PO Import" Excel, recalculated server-side for the
  // Supplier Partner model. Every field stays editable; Create Container posts the
  // Goods OTW voucher exactly as a manual entry would.
  const applyExcelImport = useCallback(
    (imported: SpExcelImportContainer) => {
      if (imported.supplierId !== null) {
        form.setValue("supplierId", imported.supplierId, { shouldDirty: true });
        form.setValue("supplierName", imported.supplierName, { shouldDirty: true });
      }
      if (imported.containerNumber) form.setValue("containerNumber", imported.containerNumber, { shouldDirty: true });
      form.setValue("invoiceNumber", imported.suggestedInvoiceNumber, { shouldDirty: true });
      form.setValue("invoiceTotalUsd", imported.invoiceTotalUsd.toFixed(2), { shouldDirty: true });
      form.setValue("discountPct", String(imported.discountPct), { shouldDirty: true });
      form.setValue("freightEstimateUsd", imported.freightEstimateUsd.toFixed(2), { shouldDirty: true });
      form.setValue("surchargeUsd", imported.surchargeUsd.toFixed(2), { shouldDirty: true });
      form.setValue("fumigationUsd", imported.fumigationUsd.toFixed(2), { shouldDirty: true });
      form.setValue("documentChargesUsd", imported.documentChargesUsd.toFixed(2), { shouldDirty: true });
      form.setValue("notes", imported.notes, { shouldDirty: true });
      form.setValue(
        "lines",
        imported.lines.map((line) => ({
          articleCode: line.articleCode,
          description: line.description,
          qty: String(line.qty),
          unitRateUsd: String(line.unitRateUsd),
          stockItemId: line.stockItemId,
        })),
        { shouldDirty: true }
      );
      setShowPaste(false);
    },
    [form]
  );

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((d) => createMutation.mutate(d))} className="space-y-5" noValidate>
        <SpContainerExcelImport onApply={applyExcelImport} />

        {/* Supplier & Header */}
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Supplier &amp; Invoice</p>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              control={form.control}
              name="supplierId"
              render={({ field }) => (
                <FormItem className="col-span-2">
                  <FormLabel>Supplier</FormLabel>
                  <Select
                    value={field.value ? String(field.value) : ""}
                    onValueChange={(val) => {
                      const id = parseInt(val);
                      field.onChange(id);
                      const found = suppliers.find((s) => s.id === id);
                      if (found) form.setValue("supplierName", found.legalName);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="select-sp-supplier">
                        <SelectValue placeholder="Select supplier…" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {suppliers.map((s) => (
                        <SelectItem key={s.id} value={String(s.id)}>
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
              name="supplierName"
              render={({ field }) => (
                <FormItem className="col-span-2">
                  <FormLabel>
                    Supplier Name{" "}
                    <span className="text-muted-foreground font-normal text-xs">(override or type if unlisted)</span>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-sp-supplier-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="containerNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Container No. <span className="text-muted-foreground font-normal text-xs">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="ABCD1234567" {...field} data-testid="input-sp-container-number" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="invoiceNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Invoice Number</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-sp-invoice-number" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="invoiceDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Invoice Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} data-testid="input-sp-invoice-date" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="invoiceTotalUsd"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Invoice Total (USD)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="0.00"
                      {...field}
                      data-testid="input-sp-invoice-total"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="discountPct"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Discount %</FormLabel>
                  <FormControl>
                    <Input type="number" step="0.01" placeholder="0" {...field} data-testid="input-sp-discount-pct" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* Supplier-invoice charges: part of the invoice total, added to landed cost at offload. */}
            {(
              [
                { name: "freightEstimateUsd", label: "Freight (USD)", testId: "input-sp-freight-estimate" },
                { name: "surchargeUsd", label: "Surcharge (USD)", testId: "input-sp-surcharge" },
                { name: "fumigationUsd", label: "Fumigation (USD)", testId: "input-sp-fumigation" },
                { name: "documentChargesUsd", label: "Document Charges (USD)", testId: "input-sp-document-charges" },
              ] as const
            ).map((charge) => (
              <FormField
                key={charge.name}
                control={form.control}
                name={charge.name}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{charge.label}</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="0.00" {...field} data-testid={charge.testId} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem className="col-span-2">
                  <FormLabel>
                    Notes <span className="text-muted-foreground font-normal text-xs">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-sp-notes" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <Separator />

        {/* Voucher Preview */}
        {invoiceTotal > 0 && (
          <div className="rounded-md border border-border bg-muted/20 p-3 space-y-1.5">
            <div className="flex items-center gap-2 mb-1">
              <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Journal Preview</p>
            </div>
            <div className="grid grid-cols-3 text-xs text-muted-foreground font-medium pb-1 border-b border-border/40">
              <span className="col-span-2">Account</span>
              <span className="text-right">Dr / Cr</span>
            </div>
            <div className="grid grid-cols-3 text-xs py-0.5">
              <span className="col-span-2 font-medium">
                Goods OTW{" "}
                <Badge variant="secondary" className="ml-1 text-xs">
                  Dr
                </Badge>
              </span>
              <span className="text-right tabular-nums font-semibold">{fmt2(invoiceTotal)}</span>
            </div>
            <div className="grid grid-cols-3 text-xs py-0.5 text-muted-foreground">
              <span className="col-span-2 pl-4">Goods OTW Clearing (Cr)</span>
              <span className="text-right tabular-nums">{fmt2(invoiceTotal)}</span>
            </div>
          </div>
        )}

        {/* Line Items */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Line Items</p>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowPaste(!showPaste)}
                data-testid="button-sp-paste"
              >
                <ClipboardPaste className="h-3.5 w-3.5 mr-1" />
                Paste
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  append({ articleCode: "", description: "", qty: "", unitRateUsd: "", stockItemId: null })
                }
                data-testid="button-sp-add-line"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add Row
              </Button>
            </div>
          </div>

          {showPaste && (
            <div className="space-y-2 p-3 border border-border rounded-md bg-muted/20">
              <p className="text-xs text-muted-foreground">
                Tab-separated: ArticleCode [Tab] Description [Tab] Qty [Tab] Rate (or 3 columns without description)
              </p>
              <Textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={"A001\tUsed Clothing\t500\t1.20\nA002\tShoes\t200\t2.50"}
                className="text-xs font-mono"
                rows={4}
                data-testid="textarea-sp-paste"
              />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowPaste(false);
                    setPasteText("");
                  }}
                >
                  Cancel
                </Button>
                <Button type="button" size="sm" onClick={parsePaste} data-testid="button-sp-parse-paste">
                  Import Lines
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-md border border-border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs w-[120px]">Article Code</TableHead>
                  <TableHead className="text-xs">Description</TableHead>
                  <TableHead className="text-xs w-[80px]">Qty</TableHead>
                  <TableHead className="text-xs w-[90px]">Rate (USD)</TableHead>
                  <TableHead className="text-xs w-[90px] text-right">Cost</TableHead>
                  <TableHead className="text-xs w-[40px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fields.map((field, idx) => {
                  const line = watchLines[idx];
                  const lineCost = parseFloat(line?.qty || "0") * parseFloat(line?.unitRateUsd || "0") * discountFactor;
                  return (
                    <TableRow key={field.id}>
                      <TableCell className="p-1">
                        <Input
                          {...form.register(`lines.${idx}.articleCode`)}
                          placeholder="A001"
                          className="h-7 text-xs"
                          data-testid={`input-sp-line-article-${idx}`}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Input
                          {...form.register(`lines.${idx}.description`)}
                          placeholder="Description"
                          className="h-7 text-xs"
                          data-testid={`input-sp-line-desc-${idx}`}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Input
                          {...form.register(`lines.${idx}.qty`)}
                          type="number"
                          step="0.01"
                          placeholder="0"
                          className="h-7 text-xs"
                          data-testid={`input-sp-line-qty-${idx}`}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Input
                          {...form.register(`lines.${idx}.unitRateUsd`)}
                          type="number"
                          step="0.0001"
                          placeholder="0.00"
                          className="h-7 text-xs"
                          data-testid={`input-sp-line-rate-${idx}`}
                        />
                      </TableCell>
                      <TableCell className="p-1 text-right">
                        <span className="text-xs tabular-nums text-muted-foreground">{fmt2(lineCost)}</span>
                      </TableCell>
                      <TableCell className="p-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => remove(idx)}
                          disabled={fields.length === 1}
                          data-testid={`button-sp-remove-line-${idx}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="flex justify-end text-xs text-muted-foreground gap-4 px-1">
            <span>
              {fields.length} line{fields.length !== 1 ? "s" : ""}
            </span>
            <span>
              Discounted total: <span className="font-semibold">{fmt2(totalBaseCost)}</span>
            </span>
            <span data-testid="text-sp-invoice-charges-total">
              Invoice charges: <span className="font-semibold">{fmt2(invoiceChargesTotal)}</span>
            </span>
            <span data-testid="text-sp-expected-invoice-total">
              Base + charges: <span className="font-semibold">{fmt2(totalBaseCost + invoiceChargesTotal)}</span>
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-sp-cancel">
            Cancel
          </Button>
          <Button type="submit" disabled={createMutation.isPending} data-testid="button-sp-submit">
            {createMutation.isPending ? "Creating..." : "Create Container"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────
export function AddContainerDialog({ open, onOpenChange, isSP = false }: AddContainerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={isSP ? "max-w-3xl max-h-[90vh] overflow-y-auto" : "max-w-md"}>
        <DialogHeader>
          <DialogTitle>{isSP ? "Import Container" : "Add Container"}</DialogTitle>
          <DialogDescription>
            {isSP
              ? "Upload the PO Import Excel or record the supplier invoice by hand. Posts: Dr Goods OTW / Cr Goods OTW Clearing."
              : "Manually add a container to the system"}
          </DialogDescription>
        </DialogHeader>
        {isSP ? <SpContainerForm onOpenChange={onOpenChange} /> : <ErpContainerForm onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}
