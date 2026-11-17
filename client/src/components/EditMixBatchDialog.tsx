import { formatNumber } from "@/lib/formatNumber";
import { Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { MixBatchRecordedDetailsDialog } from "./MixBatchRecordedDetailsDialog";
import { type EditMixBatchDialogProps } from "./editMixBatchSources";
import { useEditMixBatchDialogState } from "./useEditMixBatchDialogState";
import {
  EditMixBatchDialogMixBatchRecordedValuation,
  EditMixBatchDialogMixSourceEditReview,
  EditMixBatchDialogSection,
} from "./EditMixBatchDialogSection";

export function EditMixBatchDialog(props: EditMixBatchDialogProps) {
  const {
    addSourceType,
    availableBatchesForSource,
    availableSuppliers,
    batch,
    batchDate,
    batchName,
    belowUsed,
    blendedCostPerKg,
    currentSources,
    currentUsedKg,
    errorMessage,
    handleAddSource,
    handleRemoveSource,
    handleSourceIdChange,
    handleUpdateSourceWeight,
    hasMissingCurrentRates,
    hideCosts,
    historicalSourcesLocked,
    notes,
    onOpenChange,
    open,
    originalSupplierRates,
    previewMutation,
    readOnly,
    recordedBatchCost,
    saveMutation,
    savedSourceDifference,
    selectedSourceId,
    selectedSources,
    setAddSourceType,
    setBatchDate,
    setBatchName,
    setNotes,
    setSelectedSourceId,
    setSourceEditReason,
    setSourceReview,
    setWeightInput,
    sourceEditReason,
    sourceReview,
    sourcesChanged,
    sourcesError,
    sourcesLoading,
    totalCost,
    totalWeight,
    weightInput,
  } = useEditMixBatchDialogState(props);

  // Reuse the Raw Materials mix-batch dialog as a safe historical viewer in
  // Production Overview. Display saved source rows, not today's supplier rates:
  // supplier cost/kg can legitimately change after the original mix.
  if (readOnly) {
    return (
      <MixBatchRecordedDetailsDialog
        batch={batch}
        open={open}
        onOpenChange={onOpenChange}
        hideCosts={hideCosts}
        errorMessage={errorMessage}
        currentSources={currentSources}
        sourcesLoading={sourcesLoading}
        sourcesError={sourcesError}
        recordedBatchCost={recordedBatchCost}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Mix Batch — {batch?.batchCode}</DialogTitle>
          <DialogDescription>
            Recorded historical costs stay separate from today's supplier-rate estimate. Saving a source edit currently
            reverses and reapplies consumption; already-produced bales ({formatNumber(currentUsedKg)} kg used) must
            remain covered.
          </DialogDescription>
        </DialogHeader>

        {sourcesLoading ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Historical snapshot. It never uses the live raw-stock supplier rate. */}
            <EditMixBatchDialogMixBatchRecordedValuation
              currentSources={currentSources}
              recordedBatchCost={recordedBatchCost}
              savedSourceDifference={savedSourceDifference}
            />
            {/* Name / Date row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Batch Name</Label>
                <Input
                  value={batchName}
                  onChange={(e) => setBatchName(e.target.value)}
                  placeholder={batch?.batchCode || ""}
                  data-testid="input-edit-batch-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Batch Date</Label>
                <Input
                  type="date"
                  value={batchDate}
                  onChange={(e) => {
                    setBatchDate(e.target.value);
                    setSourceReview(null);
                  }}
                  data-testid="input-edit-batch-date"
                />
              </div>
            </div>

            {/* Add source controls */}
            <EditMixBatchDialogSection
              addSourceType={addSourceType}
              availableBatchesForSource={availableBatchesForSource}
              availableSuppliers={availableSuppliers}
              handleAddSource={handleAddSource}
              handleSourceIdChange={handleSourceIdChange}
              historicalSourcesLocked={historicalSourcesLocked}
              selectedSourceId={selectedSourceId}
              setAddSourceType={setAddSourceType}
              setSelectedSourceId={setSelectedSourceId}
              setWeightInput={setWeightInput}
              weightInput={weightInput}
            />

            {/* Sources table */}
            {selectedSources.length > 0 && (
              <div className="border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                      <TableHead className="text-right">Current $/kg</TableHead>
                      <TableHead className="text-right">Estimated cost</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedSources.map((sel) => (
                      <TableRow key={`${sel.type}-${sel.sourceId}`}>
                        <TableCell>
                          <Badge variant={sel.type === "batch" ? "secondary" : "outline"}>
                            {sel.type === "batch" ? "Batch" : "Supplier"}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-medium">{sel.label}</TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            className="h-7 w-28 text-right font-mono text-xs ml-auto"
                            value={sel.weightKg}
                            step="0.001"
                            min="0.001"
                            onChange={(e) => handleUpdateSourceWeight(sel.type, sel.sourceId, e.target.value)}
                            disabled={historicalSourcesLocked}
                            data-testid={`input-weight-${sel.type}-${sel.sourceId}`}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          {sel.type === "supplier" ? (
                            <div className="text-right">
                              <span
                                className="font-mono text-xs text-muted-foreground"
                                data-testid={`text-cost-per-kg-${sel.type}-${sel.sourceId}`}
                                title={
                                  historicalSourcesLocked
                                    ? "Recorded weighted-average supplier rate at the time of the mix"
                                    : "Current supplier rate, used only for an edit estimate"
                                }
                              >
                                ${sel.costPerKg.toFixed(4)}
                              </span>
                              {!historicalSourcesLocked && originalSupplierRates.has(sel.sourceId) && (
                                <div
                                  className="text-[11px] text-muted-foreground"
                                  title="Saved weighted-average supplier cost in this batch"
                                >
                                  Recorded: ${originalSupplierRates.get(sel.sourceId)!.toFixed(4)}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span
                              className="font-mono text-xs text-muted-foreground"
                              title="Recorded cost of the upstream batch. Only its source/weight can be changed."
                              data-testid={`text-cost-per-kg-${sel.type}-${sel.sourceId}`}
                            >
                              ${sel.costPerKg.toFixed(4)}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          ${formatNumber(sel.totalCost, 4)}
                        </TableCell>
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemoveSource(sel.type, sel.sourceId)}
                            disabled={historicalSourcesLocked}
                            data-testid={`button-remove-${sel.type}-${sel.sourceId}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Totals */}
            <div className="grid grid-cols-3 gap-4 p-4 bg-muted rounded-md">
              <div>
                <p className="text-sm text-muted-foreground">Total Weight</p>
                <p className={`text-2xl font-bold font-mono ${belowUsed ? "text-destructive" : ""}`}>
                  {formatNumber(totalWeight)} kg
                </p>
                {belowUsed && (
                  <p className="text-xs text-destructive mt-1">Below already-used {formatNumber(currentUsedKg)} kg</p>
                )}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {historicalSourcesLocked ? "Recorded total cost" : "Estimated total cost if saved"}
                </p>
                <p className="text-2xl font-bold font-mono">
                  {hasMissingCurrentRates
                    ? "Unavailable"
                    : "$" + formatNumber(historicalSourcesLocked ? recordedBatchCost.totalCost : totalCost, 4)}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {historicalSourcesLocked ? "Recorded blended cost/kg" : "Estimated blended cost/kg if saved"}
                </p>
                <p className="text-2xl font-bold font-mono" data-testid="text-edit-current-estimate">
                  {hasMissingCurrentRates
                    ? "Unavailable"
                    : "$" + (historicalSourcesLocked ? recordedBatchCost.costPerKg : blendedCostPerKg).toFixed(4)}
                </p>
              </div>
            </div>

            {hasMissingCurrentRates && (
              <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">
                One or more suppliers have no current USD rate. The current-rate estimate is unavailable; their recorded
                historical costs remain unchanged.
              </p>
            )}
            <p className="text-xs text-muted-foreground" data-testid="mix-batch-cost-basis-notice">
              {historicalSourcesLocked
                ? "Completed batch: the recorded supplier source costs and blended total match the saved batch list. Current supplier rates may differ; changing the historical valuation requires a reviewed recost, not an ordinary edit."
                : "The estimate uses current supplier rates for proposed edits and is not a correction to recorded historical costs. Source changes require a server review and approval."}
            </p>

            {sourcesChanged && (
              <EditMixBatchDialogMixSourceEditReview
                setSourceEditReason={setSourceEditReason}
                setSourceReview={setSourceReview}
                sourceEditReason={sourceEditReason}
                sourceReview={sourceReview}
              />
            )}

            {/* Notes */}
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes..."
                rows={2}
                data-testid="input-edit-batch-notes"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-edit">
                Cancel
              </Button>
              {sourcesChanged && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => previewMutation.mutate()}
                  disabled={
                    previewMutation.isPending ||
                    saveMutation.isPending ||
                    !currentSources ||
                    selectedSources.length === 0
                  }
                  data-testid="button-preview-source-edit"
                >
                  {previewMutation.isPending ? "Reviewing…" : "Review Source Changes"}
                </Button>
              )}
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={
                  saveMutation.isPending ||
                  previewMutation.isPending ||
                  !!sourcesError ||
                  !currentSources ||
                  selectedSources.length === 0 ||
                  (sourcesChanged && (!sourceReview?.allowed || !sourceReview.reviewHash))
                }
                data-testid="button-save-edit"
              >
                {saveMutation.isPending ? "Saving…" : sourcesChanged ? "Apply Reviewed Changes" : "Save"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
