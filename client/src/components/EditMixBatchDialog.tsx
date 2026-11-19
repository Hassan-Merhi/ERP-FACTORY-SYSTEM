import { formatNumber } from "@/lib/formatNumber";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { MixBatchRecordedDetailsDialog } from "./MixBatchRecordedDetailsDialog";
import { type EditMixBatchDialogProps } from "./editMixBatchSources";
import { useEditMixBatchDialogState } from "./useEditMixBatchDialogState";
import {
  EditMixBatchDialogMixBatchRecordedValuation,
  EditMixBatchDialogMixSourceEditReview,
  EditMixBatchDialogSection,
} from "./EditMixBatchDialogSection";
import { formatUsd } from "@/lib/moneyDisplay";
import { EditMixBatchDialogContent } from "./EditMixBatchDialogContent";

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
              <EditMixBatchDialogContent
                handleRemoveSource={handleRemoveSource}
                handleUpdateSourceWeight={handleUpdateSourceWeight}
                historicalSourcesLocked={historicalSourcesLocked}
                originalSupplierRates={originalSupplierRates}
                selectedSources={selectedSources}
              />
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
                    : formatUsd(historicalSourcesLocked ? recordedBatchCost.totalCost : totalCost, 0, 4)}
                </p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  {historicalSourcesLocked ? "Recorded blended cost/kg" : "Estimated blended cost/kg if saved"}
                </p>
                <p className="text-2xl font-bold font-mono" data-testid="text-edit-current-estimate">
                  {hasMissingCurrentRates
                    ? "Unavailable"
                    : formatUsd(historicalSourcesLocked ? recordedBatchCost.costPerKg : blendedCostPerKg, 4)}
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
