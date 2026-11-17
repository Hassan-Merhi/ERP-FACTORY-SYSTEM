import { AlertTriangle, Loader2, Package, Plus, Save, Upload } from "lucide-react";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "./components/StatusBadge";
import type { useSupplierProfitCheckModel } from "./useSupplierProfitCheckModel";

type ProfitModel = ReturnType<typeof useSupplierProfitCheckModel>;

export function SupplierProfitCheckDialogs({ model }: { model: ProfitModel }) {
  return (
    <>
      <AddItemDialog model={model} />
      <ImportDialog model={model} />
      <ConfirmProformaDialog model={model} />
    </>
  );
}

function AddItemDialog({ model }: { model: ProfitModel }) {
  const reset = () => {
    model.setNewItemCode("");
    model.setNewItemName("");
    model.setNewItemGroupId("");
    model.setNewItemDubaiPrice("");
    model.setNewItemAvgSell("");
  };
  return (
    <Dialog
      open={model.showAddItemDialog}
      onOpenChange={(open) => {
        model.setShowAddItemDialog(open);
        if (!open) reset();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="w-5 h-5" /> Add Item to Stock
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Create a new stock item that will immediately appear in this supplier's analysis.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code *">
              <Input
                placeholder="e.g. ITEM-001"
                value={model.newItemCode}
                onChange={(event) => model.setNewItemCode(event.target.value.toUpperCase())}
                className="font-mono"
                data-testid="input-new-item-code"
              />
            </Field>
            <Field label="Name *">
              <Input
                placeholder="Item name"
                value={model.newItemName}
                onChange={(event) => model.setNewItemName(event.target.value)}
                data-testid="input-new-item-name"
              />
            </Field>
          </div>
          <Field label="Stock Group">
            <Select value={model.newItemGroupId} onValueChange={model.setNewItemGroupId}>
              <SelectTrigger data-testid="select-new-item-group">
                <SelectValue placeholder="No group (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No group</SelectItem>
                {model.stockGroups.map((group) => (
                  <SelectItem key={group.id} value={String(group.id)}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <PriceField
              label="Dubai Price"
              value={model.newItemDubaiPrice}
              setValue={model.setNewItemDubaiPrice}
              testId="input-new-item-dubai-price"
            />
            <PriceField
              label="Avg Sell Price"
              value={model.newItemAvgSell}
              setValue={model.setNewItemAvgSell}
              testId="input-new-item-avg-sell"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => model.setShowAddItemDialog(false)}
            disabled={model.addItemMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!model.newItemCode.trim() || !model.newItemName.trim()) {
                model.toast({ title: "Code and name are required", variant: "destructive" });
                return;
              }
              model.addItemMutation.mutate({
                code: model.newItemCode.trim(),
                name: model.newItemName.trim(),
                supplierId: Number(model.supplierId),
                stockGroupId:
                  model.newItemGroupId && model.newItemGroupId !== "none" ? Number(model.newItemGroupId) : undefined,
                dubaiPrice: model.newItemDubaiPrice ? Number(model.newItemDubaiPrice) : undefined,
                avgSellPrice: model.newItemAvgSell ? Number(model.newItemAvgSell) : undefined,
              });
            }}
            disabled={model.addItemMutation.isPending || !model.newItemCode.trim() || !model.newItemName.trim()}
            data-testid="button-confirm-add-item"
          >
            {model.addItemMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Adding…
              </>
            ) : (
              <>
                <Plus className="w-4 h-4 mr-2" />
                Add Item
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ model }: { model: ProfitModel }) {
  return (
    <Dialog
      open={model.showImportDialog}
      onOpenChange={(open) => {
        if (!open) {
          model.setShowImportDialog(false);
          model.setImportPreview(null);
        }
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" /> Import Items from Excel
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Expected Excel format:</p>
            <p>Row 1 = headers. Supported column names (case-insensitive):</p>
            <ul className="list-disc list-inside space-y-0.5 ml-1">
              <li>
                <strong>Code</strong> (required) — item code from ERP
              </li>
              <li>
                <strong>Cost / Dubai / PO Price</strong> (optional) — overrides cost price
              </li>
              <li>
                <strong>Sell / Avg Price</strong> (optional) — overrides selling price
              </li>
              <li>
                <strong>Qty / Quantity</strong> (optional) — pre-fills order qty
              </li>
            </ul>
          </div>
          {model.importParsed.length > 0 && (
            <div className="text-sm text-muted-foreground">
              Parsed <strong className="text-foreground">{model.importParsed.length}</strong> code(s) from file.
            </div>
          )}
          {model.importLoading && (
            <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              Looking up items…
            </div>
          )}
          {model.importPreview && !model.importLoading && <ImportPreview model={model} />}
        </div>
        <DialogFooter className="gap-2 border-t pt-4">
          <Button
            variant="outline"
            onClick={() => {
              model.setShowImportDialog(false);
              model.setImportPreview(null);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={model.handleConfirmImport}
            disabled={!model.importPreview || model.importPreview.rows.length === 0 || model.importLoading}
            data-testid="button-confirm-import"
          >
            <Upload className="w-4 h-4 mr-2" />
            Add {model.importPreview?.rows.length ?? 0} Item(s) to Analysis
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportPreview({ model }: { model: ProfitModel }) {
  const preview = model.importPreview!;
  return (
    <div className="space-y-3">
      {preview.notFound.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-1">
            {preview.notFound.length} code(s) not found in ERP:
          </p>
          <p className="text-xs text-muted-foreground font-mono">{preview.notFound.join(", ")}</p>
        </div>
      )}
      {preview.rows.length > 0 ? (
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b">
                  {["Code", "Name", "Cost Price", "Avg Sell", "Profit", "Status"].map((heading) => (
                    <th
                      key={heading}
                      className={`${heading === "Name" || heading === "Code" ? "text-left" : heading === "Status" ? "text-center" : "text-right"} px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide`}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, index) => {
                  const parsed = model.importParsed.find((item) => item.code.toLowerCase() === row.code.toLowerCase());
                  const costPrice = parsed?.costPrice ?? row.poPrice;
                  const sellPrice = parsed?.sellPrice ?? row.avgSellingPrice;
                  const profit = sellPrice != null && costPrice != null ? sellPrice - costPrice : null;
                  return (
                    <tr
                      key={row.stockItemId}
                      className={`border-b last:border-0 ${index % 2 === 1 ? "bg-muted/20" : ""}`}
                    >
                      <td className="px-3 py-2 font-mono text-xs">{row.code}</td>
                      <td className="px-3 py-2 text-xs max-w-[200px] truncate">{row.name}</td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums">
                        {costPrice != null ? `$${costPrice.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums">
                        {sellPrice != null ? `$${sellPrice.toFixed(2)}` : "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right text-xs tabular-nums font-semibold ${profit != null && profit > 0 ? "text-emerald-500" : profit != null && profit < 0 ? "text-red-500" : "text-muted-foreground"}`}
                      >
                        {profit != null ? `${profit < 0 ? "-" : ""}$${Math.abs(profit).toFixed(2)}` : "—"}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <StatusBadge status={row.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground text-sm">
          <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
          None of the codes matched items in the ERP.
        </div>
      )}
    </div>
  );
}

function ConfirmProformaDialog({ model }: { model: ProfitModel }) {
  const summary = model.summary;
  return (
    <Dialog open={model.showConfirmModal} onOpenChange={model.setShowConfirmModal}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Save className="w-5 h-5" /> Confirm Proforma Creation
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <Summary label="Items Selected" value={summary.selectedCount} />
            <Summary label="Total Quantity" value={summary.totalQty.toLocaleString()} />
            <Summary
              label="Total Landing Cost"
              value={formatMoneyDisplay(summary.totalLandingCost, {
                currency: "USD",
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            />
            <Summary
              label="Cost Profit"
              value={`${summary.totalCostProfit < 0 ? "-" : ""}${formatMoneyDisplay(Math.abs(summary.totalCostProfit), { currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              danger={summary.totalCostProfit < 0}
            />
            <Summary label="Losing Items" value={summary.losingCount} danger={summary.losingCount > 0} />
            <Summary label="No PO Price" value={summary.missingPoCount} danger={summary.missingPoCount > 0} />
          </div>
          {summary.losingCount > 0 && (
            <div className="flex gap-2 items-start rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 text-sm text-red-600 dark:text-red-400">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{summary.losingCount} item(s) are cost-losing. Review before confirming.</span>
            </div>
          )}
          <div className="space-y-2">
            <Field label="Proforma Reference">
              <Input
                placeholder="Auto-generated if blank"
                value={model.proformaRef}
                onChange={(event) => model.setProformaRef(event.target.value)}
                data-testid="input-proforma-ref"
              />
            </Field>
            <Field label="Notes (optional)">
              <Input
                placeholder="Any notes..."
                value={model.proformaNotes}
                onChange={(event) => model.setProformaNotes(event.target.value)}
                data-testid="input-proforma-notes"
              />
            </Field>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => model.setShowConfirmModal(false)} disabled={model.isSaving}>
            Cancel
          </Button>
          <Button onClick={model.handleSaveProforma} disabled={model.isSaving} data-testid="button-confirm-save">
            {model.isSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            {model.isSaving ? "Saving..." : "Save Proforma"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function PriceField({
  label,
  value,
  setValue,
  testId,
}: {
  label: string;
  value: string;
  setValue: (value: string) => void;
  testId: string;
}) {
  return (
    <Field label={`${label} (optional)`}>
      <div className="relative">
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">$</span>
        <Input
          type="number"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="pl-6 font-mono"
          data-testid={testId}
        />
      </div>
    </Field>
  );
}

function Summary({ label, value, danger = false }: { label: string; value: string | number; danger?: boolean }) {
  return (
    <div className="rounded-lg border p-2.5 bg-muted/30">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm font-semibold ${danger ? "text-red-500" : ""}`}>{value}</div>
    </div>
  );
}
