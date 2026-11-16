import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FileText } from "lucide-react";
import { SpContainerExcelImport } from "./SpContainerExcelImport";
import { ErpContainerForm, fmt2 } from "./ErpContainerForm";
import { SpContainerFormSection, useSpContainerFormState } from "./SpContainerFormSection";

interface AddContainerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isSP?: boolean;
}

// ── SP form ──────────────────────────────────────────────────────────────────
function SpContainerForm(props: { onOpenChange: (open: boolean) => void }) {
  const {
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
  } = useSpContainerFormState(props);

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
        <SpContainerFormSection
          append={append}
          discountFactor={discountFactor}
          fields={fields}
          form={form}
          invoiceChargesTotal={invoiceChargesTotal}
          parsePaste={parsePaste}
          pasteText={pasteText}
          remove={remove}
          setPasteText={setPasteText}
          setShowPaste={setShowPaste}
          showPaste={showPaste}
          totalBaseCost={totalBaseCost}
          watchLines={watchLines}
        />

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
