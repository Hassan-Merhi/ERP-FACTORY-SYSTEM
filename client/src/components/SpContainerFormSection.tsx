// Extracted from ./AddContainerDialog.tsx to keep that module under the source-size cap.
import { useCallback, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ClipboardPaste, Plus, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { SpExcelImportContainer } from "@shared/spContainerExcelImport";
import { spContainerInvoiceChargesTotal } from "@shared/spContainerInvoiceCharges";
import { fmt2, spFormSchema, type SpForm } from "./ErpContainerForm";

export function useSpContainerFormState({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
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
  return {
    append,
    applyExcelImport,
    createMutation,
    discountFactor,
    fields,
    form,
    invoiceChargesTotal,
    invoiceTotal,
    onOpenChange,
    parsePaste,
    pasteText,
    remove,
    setPasteText,
    setShowPaste,
    showPaste,
    suppliers,
    totalBaseCost,
    watchLines,
  };
}

export function SpContainerFormSection({
  append,
  discountFactor,
  fields,
  form,
  invoiceChargesTotal,
  parsePaste,
  pasteText,
  remove,
  setPasteText,
  setShowPaste,
  showPaste,
  totalBaseCost,
  watchLines,
}: Pick<
  ReturnType<typeof useSpContainerFormState>,
  | "append"
  | "discountFactor"
  | "fields"
  | "form"
  | "invoiceChargesTotal"
  | "parsePaste"
  | "pasteText"
  | "remove"
  | "setPasteText"
  | "setShowPaste"
  | "showPaste"
  | "totalBaseCost"
  | "watchLines"
>) {
  return (
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
            onClick={() => append({ articleCode: "", description: "", qty: "", unitRateUsd: "", stockItemId: null })}
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
  );
}
