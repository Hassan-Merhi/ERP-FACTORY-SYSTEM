import { formatNumber } from "@/lib/formatNumber";
import { Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { MIX_BATCH_TARGET_OPTIONS } from "@/pages/factory/production-raw-stock/mixBatchCategoryTargets";
import type { CreateMixBatchDialogProps } from "./CreateMixBatchDialogTypes";
import { useCreateMixBatchDialogState } from "./useCreateMixBatchDialogState";
import { CreateMixBatchDialogSection } from "./CreateMixBatchDialogSection";
import { formatUsd } from "@/lib/moneyDisplay";

export function CreateMixBatchDialog(props: CreateMixBatchDialogProps) {
  const {
    activeBatchesForTopup,
    addSourceType,
    automaticTargetTons,
    availableBatchesForSource,
    availableSuppliers,
    batchDate,
    batchName,
    blendedCostPerKg,
    canSubmitMode,
    createMutation,
    handleAddSource,
    handleClose,
    handleRemoveSource,
    handleSourceIdChange,
    hasAnySources,
    isPending,
    mode,
    notes,
    open,
    recordChanges,
    selectedSourceId,
    selectedSources,
    setAddSourceType,
    setBatchDate,
    setBatchName,
    setMode,
    setNotes,
    setSelectedSourceId,
    setTargetBatchId,
    setWeightInput,
    targetBatchId,
    tierText,
    topUpMutation,
    totalCost,
    totalWeight,
    weightInput,
  } = useCreateMixBatchDialogState(props);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "topup" ? "Add to Existing Batch" : "Create Mix Batch"}</DialogTitle>
          <DialogDescription>
            {mode === "topup"
              ? "Select which batch to add stock to, then choose your sources below."
              : "Combine supplier raw stock and/or existing batches into a new batch."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === "new" ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setMode("new");
                setTargetBatchId("");
              }}
              data-testid="button-mode-new"
            >
              New Batch
            </Button>
            {recordChanges.allowed && (
              <Button
                type="button"
                variant={mode === "topup" ? "default" : "outline"}
                size="sm"
                onClick={() => setMode("topup")}
                data-testid="button-mode-topup"
              >
                Add to Existing Batch
              </Button>
            )}
          </div>

          {mode === "new" && (
            <div className="space-y-2" data-testid="mix-batch-production-target-selector">
              <div className="flex flex-wrap items-center gap-2">
                <Label>{tierText("productionTarget")}</Label>
                <span
                  role="status"
                  className="text-xs text-muted-foreground"
                  data-testid="mix-batch-production-target-status"
                >
                  {totalWeight > 0
                    ? tierText("tierLabel", { kg: formatNumber(totalWeight), ton: automaticTargetTons })
                    : tierText("selectSources")}
                </span>
              </div>
              <div
                className="inline-flex max-w-full rounded-md border border-border bg-muted/40 p-1 gap-1"
                role="group"
                aria-label="Automatically selected production target"
              >
                {MIX_BATCH_TARGET_OPTIONS.map((tons) => (
                  <span
                    key={tons}
                    aria-current={automaticTargetTons === tons ? "true" : undefined}
                    className={
                      automaticTargetTons === tons
                        ? "flex min-h-9 min-w-20 items-center justify-center rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-sm"
                        : "flex min-h-9 min-w-20 items-center justify-center rounded-md px-3 text-sm font-semibold text-muted-foreground"
                    }
                    data-testid={`mix-batch-target-${tons}`}
                  >
                    {tierText("tons", { ton: tons })}
                  </span>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{tierText("advances")}</p>
            </div>
          )}

          {/* Top-up: pick target batch */}
          {mode === "topup" && (
            <div className="space-y-2">
              <Label>Select Batch to Add To</Label>
              <Select value={targetBatchId} onValueChange={setTargetBatchId}>
                <SelectTrigger data-testid="select-target-batch">
                  <SelectValue placeholder="Pick a batch..." />
                </SelectTrigger>
                <SelectContent>
                  {activeBatchesForTopup.map((b) => {
                    const remaining = parseFloat(b.totalWeightKg) - parseFloat(b.usedKg);
                    return (
                      <SelectItem key={b.id} value={b.id.toString()}>
                        {b.name || b.batchCode} — {formatNumber(remaining)} kg remaining @{" "}
                        {formatUsd(parseFloat(b.costPerKg), 4)}
                        /kg
                      </SelectItem>
                    );
                  })}
                  {activeBatchesForTopup.length === 0 && (
                    <SelectItem value="__none__" disabled>
                      No active batches available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* New batch: name + date */}
          {mode === "new" && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Batch Name (optional)</Label>
                <Input
                  value={batchName}
                  onChange={(e) => setBatchName(e.target.value)}
                  placeholder="e.g. Cyprus + Spain Mix"
                  data-testid="input-batch-name"
                />
              </div>
              <div className="space-y-2">
                <Label>Batch Date</Label>
                <Input
                  type="date"
                  value={batchDate}
                  onChange={(e) => setBatchDate(e.target.value)}
                  data-testid="input-batch-date"
                />
              </div>
            </div>
          )}

          {/* Top-up: operation date */}
          {mode === "topup" && (
            <div className="space-y-2">
              <Label>Operation Date</Label>
              <Input
                type="date"
                value={batchDate}
                onChange={(e) => setBatchDate(e.target.value)}
                data-testid="input-topup-date"
              />
              <p className="text-xs text-muted-foreground">
                The date this top-up is recorded on the daybook and supplier ledger.
              </p>
            </div>
          )}

          <CreateMixBatchDialogSection
            addSourceType={addSourceType}
            availableBatchesForSource={availableBatchesForSource}
            availableSuppliers={availableSuppliers}
            handleAddSource={handleAddSource}
            handleSourceIdChange={handleSourceIdChange}
            selectedSourceId={selectedSourceId}
            setAddSourceType={setAddSourceType}
            setSelectedSourceId={setSelectedSourceId}
            setWeightInput={setWeightInput}
            weightInput={weightInput}
          />

          {selectedSources.length > 0 && (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Weight (kg)</TableHead>
                    <TableHead className="text-right">Cost/kg</TableHead>
                    <TableHead className="text-right">Total Cost</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedSources.map((selection) => (
                    <TableRow key={`${selection.type}-${selection.sourceId}`}>
                      <TableCell>
                        <Badge variant={selection.type === "batch" ? "secondary" : "outline"}>
                          {selection.type === "batch" ? "Batch" : "Supplier"}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{selection.label}</TableCell>
                      <TableCell className="text-right font-mono">
                        {selection.weightKg.toLocaleString(undefined, {
                          minimumFractionDigits: 3,
                          maximumFractionDigits: 3,
                        })}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatUsd(selection.costPerKg, 4)}</TableCell>
                      <TableCell className="text-right font-mono">{formatUsd(selection.totalCost, 0, 2)}</TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemoveSource(selection.type, selection.sourceId)}
                          data-testid={`button-remove-${selection.type}-${selection.sourceId}`}
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

          <div className="grid grid-cols-3 gap-4 p-4 bg-muted rounded-md">
            <div>
              <p className="text-sm text-muted-foreground">Total Weight</p>
              <p className="text-2xl font-bold font-mono" data-testid="text-total-weight">
                {formatNumber(totalWeight)} kg
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Cost</p>
              <p className="text-2xl font-bold font-mono" data-testid="text-total-cost">
                {formatUsd(totalCost, 0, 2)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Blended Cost/kg</p>
              <p className="text-2xl font-bold font-mono" data-testid="text-cost-per-kg">
                {formatUsd(blendedCostPerKg, 4)}
              </p>
            </div>
          </div>

          {mode === "new" && (
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add any notes about this batch..."
                data-testid="input-notes"
              />
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={handleClose} data-testid="button-cancel">
              Cancel
            </Button>
            {canSubmitMode && (
              <Button
                onClick={() => (mode === "topup" ? topUpMutation.mutate() : createMutation.mutate())}
                disabled={isPending || !hasAnySources || (mode === "topup" && !targetBatchId)}
                data-testid="button-submit"
              >
                {isPending
                  ? mode === "topup"
                    ? "Adding..."
                    : "Creating..."
                  : mode === "topup"
                    ? "Add to Batch"
                    : "Create Batch"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
