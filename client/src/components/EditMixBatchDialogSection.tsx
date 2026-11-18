// Extracted from ./EditMixBatchDialog.tsx to keep that module under the source-size cap.
import { formatNumber } from "@/lib/formatNumber";
import { Layers, Package, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useEditMixBatchDialogState } from "./useEditMixBatchDialogState";
import { formatUsd } from "@/lib/moneyDisplay";

export function EditMixBatchDialogSection({
  addSourceType,
  availableBatchesForSource,
  availableSuppliers,
  handleAddSource,
  handleSourceIdChange,
  historicalSourcesLocked,
  selectedSourceId,
  setAddSourceType,
  setSelectedSourceId,
  setWeightInput,
  weightInput,
}: Pick<
  ReturnType<typeof useEditMixBatchDialogState>,
  | "addSourceType"
  | "availableBatchesForSource"
  | "availableSuppliers"
  | "handleAddSource"
  | "handleSourceIdChange"
  | "historicalSourcesLocked"
  | "selectedSourceId"
  | "setAddSourceType"
  | "setSelectedSourceId"
  | "setWeightInput"
  | "weightInput"
>) {
  return (
    <div className="space-y-3">
      <h3 className="font-medium">Sources</h3>
      {historicalSourcesLocked && (
        <p
          role="status"
          className="text-xs text-amber-600 dark:text-amber-400"
          data-testid="mix-batch-completed-source-lock"
        >
          Completed batch: source quantities are review-only until historical output and accounting reconciliation
          (Phases 3–5). Name, date and notes remain editable.
        </p>
      )}
      <div className="flex gap-2 flex-wrap">
        <Button
          type="button"
          variant={addSourceType === "supplier" ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setAddSourceType("supplier");
            setSelectedSourceId("");
            setWeightInput("");
          }}
          disabled={historicalSourcesLocked}
          data-testid="button-source-type-supplier"
        >
          <Package className="h-3 w-3 mr-1" /> Supplier Stock
        </Button>
        <Button
          type="button"
          variant={addSourceType === "batch" ? "default" : "outline"}
          size="sm"
          onClick={() => {
            setAddSourceType("batch");
            setSelectedSourceId("");
            setWeightInput("");
          }}
          disabled={historicalSourcesLocked}
          data-testid="button-source-type-batch"
        >
          <Layers className="h-3 w-3 mr-1" /> Existing Batch
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {addSourceType === "supplier" ? (
          <Select value={selectedSourceId} disabled={historicalSourcesLocked} onValueChange={handleSourceIdChange}>
            <SelectTrigger data-testid="select-supplier-source">
              <SelectValue placeholder="Select supplier" />
            </SelectTrigger>
            <SelectContent>
              {availableSuppliers?.map((stock) => (
                <SelectItem key={stock.supplierId!} value={stock.supplierId!.toString()}>
                  {stock.supplierName} ({formatNumber(parseFloat(stock.remainingKg))} kg @{" "}
                  {formatUsd(parseFloat(stock.costPerKgUsd || stock.costPerKg || "0"), 4)}
                  /kg USD)
                </SelectItem>
              ))}
              {(!availableSuppliers || availableSuppliers.length === 0) && (
                <SelectItem value="__none__" disabled>
                  No supplier stock available
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        ) : (
          <Select value={selectedSourceId} disabled={historicalSourcesLocked} onValueChange={handleSourceIdChange}>
            <SelectTrigger data-testid="select-batch-source">
              <SelectValue placeholder="Select batch" />
            </SelectTrigger>
            <SelectContent>
              {availableBatchesForSource?.map((b) => {
                const remaining = parseFloat(b.totalWeightKg) - parseFloat(b.usedKg);
                return (
                  <SelectItem key={b.id} value={b.id.toString()}>
                    {b.name || b.batchCode} (
                    {`${formatNumber(remaining)} kg @ ${formatUsd(parseFloat(b.costPerKg), 4)}/kg`})
                  </SelectItem>
                );
              })}
              {(!availableBatchesForSource || availableBatchesForSource.length === 0) && (
                <SelectItem value="__none__" disabled>
                  No active batches available
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        )}

        <Input
          type="number"
          placeholder="Weight (kg)"
          value={weightInput}
          onChange={(e) => setWeightInput(e.target.value)}
          step="0.001"
          disabled={historicalSourcesLocked}
          data-testid="input-source-weight"
        />

        <Button
          type="button"
          onClick={handleAddSource}
          disabled={historicalSourcesLocked || !selectedSourceId || !weightInput || selectedSourceId === "__none__"}
          data-testid="button-add-source"
        >
          <Plus className="h-4 w-4 mr-2" /> Add
        </Button>
      </div>
    </div>
  );
}

export function EditMixBatchDialogMixSourceEditReview({
  setSourceEditReason,
  setSourceReview,
  sourceEditReason,
  sourceReview,
}: Pick<
  ReturnType<typeof useEditMixBatchDialogState>,
  "setSourceEditReason" | "setSourceReview" | "sourceEditReason" | "sourceReview"
>) {
  return (
    <div className="space-y-3 rounded-md border border-border p-4" data-testid="mix-source-edit-review">
      <div>
        <p className="text-sm font-semibold">Review Material Source Changes</p>
        <p className="text-xs text-muted-foreground">
          An explicit review is required before stock allocations can be reversed and reapplied. This review does not
          modify inventory or create a voucher.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="mix-source-edit-reason">Reason for changing recorded materials</Label>
        <Textarea
          id="mix-source-edit-reason"
          value={sourceEditReason}
          onChange={(event) => {
            setSourceEditReason(event.target.value);
            setSourceReview(null);
          }}
          rows={2}
          placeholder="Explain the source or weight correction (at least 10 characters)"
          data-testid="input-mix-source-edit-reason"
        />
      </div>
      {sourceReview && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3" data-testid="mix-source-review-result">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Badge variant={sourceReview.allowed ? "secondary" : "destructive"}>
              {sourceReview.allowed ? "Safe to apply" : "Correction blocked"}
            </Badge>
            <span>Server-verified proposal</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Saved kg</p>
              <p className="font-mono">{formatNumber(Number(sourceReview.recordedWeightKg), 3)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Proposed kg</p>
              <p className="font-mono">{formatNumber(Number(sourceReview.proposedWeightKg), 3)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Saved USD</p>
              <p className="font-mono">{formatUsd(Number(sourceReview.recordedTotalCost), 0, 4)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Estimated USD</p>
              <p className="font-mono">
                {sourceReview.estimatedTotalCost == null
                  ? "Unavailable"
                  : formatUsd(Number(sourceReview.estimatedTotalCost), 0, 4)}
              </p>
            </div>
          </div>
          {sourceReview.estimatedDeltaUsd != null && (
            <p className="text-xs text-muted-foreground">
              Estimated valuation difference: {formatUsd(Number(sourceReview.estimatedDeltaUsd), 0, 4)} USD. The server
              recalculates the cost during the final transaction.
            </p>
          )}
          {sourceReview.warnings.map((warning, i) => (
            <p key={i} role="alert" className="text-xs text-destructive">
              {warning}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function EditMixBatchDialogMixBatchRecordedValuation({
  currentSources,
  recordedBatchCost,
  savedSourceDifference,
}: Pick<
  ReturnType<typeof useEditMixBatchDialogState>,
  "currentSources" | "recordedBatchCost" | "savedSourceDifference"
>) {
  return (
    <div className="rounded-md border border-border p-4 space-y-2" data-testid="mix-batch-recorded-valuation">
      <p className="text-sm font-semibold">Recorded Historical Valuation</p>
      <p className="text-xs text-muted-foreground">
        Saved at the original batch valuation. This matches the batch list, details, and historical export.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">Recorded weight</p>
          <p className="font-mono font-semibold">{formatNumber(recordedBatchCost.totalWeightKg, 3)} kg</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Recorded total cost</p>
          <p className="font-mono font-semibold">{formatUsd(recordedBatchCost.totalCost, 0, 4)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Recorded blended cost/kg</p>
          <p className="font-mono font-semibold" data-testid="text-edit-recorded-blended-cost">
            {formatUsd(recordedBatchCost.costPerKg, 4)}
          </p>
        </div>
      </div>
      {currentSources && savedSourceDifference > 0.02 && (
        <p role="alert" className="text-xs text-destructive">
          Recorded source total differs from the saved batch header by {formatUsd(savedSourceDifference, 0, 2)}. Review
          before changing costs.
        </p>
      )}
    </div>
  );
}
