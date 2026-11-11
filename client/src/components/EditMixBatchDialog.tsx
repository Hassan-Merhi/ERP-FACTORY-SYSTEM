import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { formatNumber } from "@/lib/formatNumber";
import { recordedMixBatchCost, summarizeRecordedMixSources } from "@/lib/recordedMixBatchCost";
import { Plus, Trash2, Layers, Package } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { FactoryMixBatch } from "@shared/schema";
import { MixBatchRecordedDetailsDialog } from "./MixBatchRecordedDetailsDialog";
import {
  hasChangedSourceWeights,
  type SupplierRawStock,
  type SourceType,
  type SourceSelection,
  type EditMixBatchDialogProps,
  type StoredMixBatchSource,
  type SourceEditReview,
} from "./editMixBatchSources";

export function EditMixBatchDialog({
  batch,
  open,
  onOpenChange,
  readOnly: readOnlyProp = false,
  hideCosts = false,
  errorMessage,
}: EditMixBatchDialogProps) {
  const { toast } = useToast();
  // Read-only company roles always get the view-only form of this dialog.
  const recordChanges = useExistingRecordChangeAccess();
  const readOnly = readOnlyProp || !recordChanges.allowed;
  const [selectedSources, setSelectedSources] = useState<SourceSelection[]>([]);
  const [addSourceType, setAddSourceType] = useState<SourceType>("supplier");
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [weightInput, setWeightInput] = useState<string>("");
  const [batchName, setBatchName] = useState("");
  const [notes, setNotes] = useState("");
  const [batchDate, setBatchDate] = useState<string>("");
  const [initialized, setInitialized] = useState(false);
  const [sourceTouched, setSourceTouched] = useState(false);
  const [sourceEditReason, setSourceEditReason] = useState("");
  const [sourceReview, setSourceReview] = useState<SourceEditReview | null>(null);

  const { data: supplierStock } = useQuery<SupplierRawStock[]>({
    queryKey: ["/api/factory/raw-stock"],
    enabled: open && !readOnly,
  });

  const { data: existingBatches } = useQuery<FactoryMixBatch[]>({
    queryKey: ["/api/factory/mix-batches"],
    enabled: open && !readOnly,
  });

  // Fetch current sources for this batch
  const {
    data: currentSources,
    isLoading: sourcesLoading,
    isError: sourcesError,
  } = useQuery<StoredMixBatchSource[]>({
    queryKey: ["/api/factory/mix-batches", batch?.id, "sources"],
    queryFn: async () => {
      const response = await fetch(`/api/factory/mix-batches/${batch!.id}/sources`, { credentials: "include" });
      if (!response.ok) throw new Error("Unable to load mix batch sources");
      return response.json();
    },
    enabled: open && !!batch,
  });

  // Pre-load fields when batch + sources are ready
  useEffect(() => {
    if (readOnly || !open || !batch || !currentSources || !supplierStock || initialized) return;

    setBatchName(batch.name || "");
    setNotes(batch.notes || "");
    setBatchDate(batch.batchDate || new Date().toLocaleDateString("en-CA"));

    // Aggregate supplier sources by supplierId
    const supplierMap = new Map<
      number,
      { weightKg: number; costPerKg: number; totalCost: number; label: string; availableKg: number }
    >();
    const batchSourceList: SourceSelection[] = [];

    for (const src of currentSources) {
      if (src.sourceBatchId) {
        // A batch can have multiple records from the same upstream mix after
        // top-ups. Merge these so the reviewed payload has one ID per source.
        const srcBatch = existingBatches?.find((b) => b.id === src.sourceBatchId);
        const remaining = srcBatch ? parseFloat(srcBatch.totalWeightKg) - parseFloat(srcBatch.usedKg) : 0;
        const weight = parseFloat(src.weightKg);
        const currentCost =
          batch.status === "COMPLETED" || batch.status === "CLOSED"
            ? parseFloat(src.costPerKg)
            : srcBatch
              ? parseFloat(srcBatch.costPerKg || "0")
              : parseFloat(src.costPerKg);
        const existing = batchSourceList.find((item) => item.sourceId === src.sourceBatchId);
        if (existing) {
          existing.weightKg += weight;
          existing.totalCost = existing.weightKg * currentCost;
          existing.costPerKg = currentCost;
          existing.availableKg = remaining + existing.weightKg;
        } else {
          batchSourceList.push({
            type: "batch",
            sourceId: src.sourceBatchId,
            label: src.sourceBatchCode || `Batch #${src.sourceBatchId}`,
            weightKg: weight,
            costPerKg: currentCost,
            totalCost: weight * currentCost,
            availableKg: remaining + weight,
          });
        }
      } else if (src.supplierId) {
        // Supplier source (may span multiple containers — aggregate by supplierId).
        // Completed batches display their original source USD snapshots. Only
        // editable batches use the latest locked supplier rate as a preview.
        // Never silently present current supplier prices as saved batch values.
        const existing = supplierMap.get(src.supplierId);
        const stockRow = supplierStock.find((s) => s.supplierId === src.supplierId);
        // Available = current remaining + what was consumed (returns on edit)
        const currentRemaining = stockRow ? parseFloat(stockRow.remainingKg) : 0;
        const currentRate = stockRow ? parseFloat(stockRow.costPerKgUsd || stockRow.costPerKg || "0") : 0;
        const srcWeight = parseFloat(src.weightKg);
        const isCompleted = batch.status === "COMPLETED" || batch.status === "CLOSED";
        const savedUsd = Number(src.totalCost) || 0;
        if (existing) {
          existing.weightKg += srcWeight;
          existing.totalCost = isCompleted ? existing.totalCost + savedUsd : existing.weightKg * currentRate;
          existing.costPerKg = isCompleted
            ? (existing.weightKg > 0 ? existing.totalCost / existing.weightKg : 0)
            : currentRate;
          existing.availableKg = currentRemaining + existing.weightKg;
        } else {
          supplierMap.set(src.supplierId, {
            weightKg: srcWeight,
            costPerKg: isCompleted && srcWeight > 0 ? savedUsd / srcWeight : currentRate,
            totalCost: isCompleted ? savedUsd : srcWeight * currentRate,
            label: src.supplierName || `Supplier #${src.supplierId}`,
            availableKg: currentRemaining + srcWeight,
          });
        }
      }
    }

    const supplierSources: SourceSelection[] = Array.from(supplierMap.entries()).map(([supplierId, val]) => ({
      type: "supplier",
      sourceId: supplierId,
      label: val.label,
      weightKg: val.weightKg,
      costPerKg: val.costPerKg,
      totalCost: val.totalCost,
      availableKg: val.availableKg,
    }));

    setSelectedSources([...supplierSources, ...batchSourceList]);
    setInitialized(true);
  }, [open, batch, currentSources, supplierStock, existingBatches, initialized, readOnly]);

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setSelectedSources([]);
      setSelectedSourceId("");
      setWeightInput("");
      setBatchName("");
      setNotes("");
      setBatchDate("");
      setInitialized(false);
      setAddSourceType("supplier");
      setSourceTouched(false);
      setSourceEditReason("");
      setSourceReview(null);
    }
  }, [open]);

  const availableSuppliers = supplierStock?.filter(
    (s) =>
      s.supplierId !== null && !selectedSources.some((sel) => sel.type === "supplier" && sel.sourceId === s.supplierId!)
  );

  const availableBatchesForSource = existingBatches?.filter((b) => {
    if (b.id === batch?.id) return false; // can't use self as source
    const remaining = parseFloat(b.totalWeightKg) - parseFloat(b.usedKg);
    return (
      remaining > 0.001 &&
      (b.status === "ACTIVE" || b.status === "OPEN" || b.status === "CARRY_FORWARD") &&
      !selectedSources.some((sel) => sel.type === "batch" && sel.sourceId === b.id)
    );
  });

  const sourcesChanged = sourceTouched && hasChangedSourceWeights(selectedSources, currentSources);

  // Never submit supplier or upstream cost/kg from the browser: the server
  // resolves all rates and quantities again during its atomic source edit.
  const sourcePayload = () => ({
    supplierSources: selectedSources
      .filter((s) => s.type === "supplier")
      .map((s) => ({ supplierId: s.sourceId, weightKg: s.weightKg.toString() })),
    batchSources: selectedSources
      .filter((s) => s.type === "batch")
      .map((s) => ({ sourceBatchId: s.sourceId, weightKg: s.weightKg.toString() })),
  });

  const previewMutation = useMutation<SourceEditReview>({
    mutationFn: async () => {
      if (!batch || !sourcesChanged) throw new Error("No source changes to review.");
      const res = await fetch(`/api/factory/mix-batches/${batch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          ...sourcePayload(),
          sourceEditReason,
          batchDate: batchDate || null,
          sourceEditPreview: true,
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.message || "Could not review mix sources.");
      return result;
    },
    onSuccess: (review) => setSourceReview(review),
    onError: (error: ClientErrorLike) => {
      setSourceReview(null);
      toast({ title: "Review failed", description: error.message, variant: "destructive" });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (sourcesChanged && (!sourceReview?.allowed || !sourceReview.reviewHash)) {
        throw new Error("Review and approve the proposed material changes before saving.");
      }
      const res = await fetch(`/api/factory/mix-batches/${batch!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: batchName.trim(),
          notes: notes.trim(),
          batchDate: batchDate || null,
          ...(sourcesChanged
            ? {
                ...sourcePayload(),
                sourceEditReason,
                sourceEditReviewHash: sourceReview!.reviewHash,
                confirmSourceEdit: true,
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Update failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches", batch?.id, "sources"] });
      setSourceReview(null);
      onOpenChange(false);
      toast({
        title: "Batch updated",
        description: "Saved with recorded costs protected and inventory changes reviewed.",
      });
    },
    onError: (err: ClientErrorLike) => {
      setSourceReview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      toast({ title: "Edit rejected", description: err.message, variant: "destructive" });
    },
  });

  const handleSourceIdChange = (id: string) => {
    setSelectedSourceId(id);
    if (addSourceType === "supplier") {
      const stock = supplierStock?.find((s) => s.supplierId?.toString() === id);
      if (stock) {
        // Only prefill if remaining is positive; leave blank for over-use scenarios
        const rem = parseFloat(stock.remainingKg);
        setWeightInput(rem > 0 ? stock.remainingKg : "");
      }
    } else {
      const b = existingBatches?.find((b) => b.id.toString() === id);
      if (b) {
        const remaining = parseFloat(b.totalWeightKg) - parseFloat(b.usedKg);
        setWeightInput(remaining > 0 ? remaining.toFixed(3) : "");
      }
    }
  };

  const handleAddSource = () => {
    if (!selectedSourceId || !weightInput) {
      toast({
        title: "Missing information",
        description: "Please select a source and enter weight",
        variant: "destructive",
      });
      return;
    }
    const weight = parseFloat(weightInput);
    if (isNaN(weight) || weight <= 0) {
      toast({
        title: "Invalid weight",
        description: "Please enter a valid weight greater than 0",
        variant: "destructive",
      });
      return;
    }

    if (addSourceType === "supplier") {
      const stock = supplierStock?.find((s) => s.supplierId?.toString() === selectedSourceId);
      if (!stock || !stock.supplierId) return;
      const available = parseFloat(stock.remainingKg);
      if (weight > available + 0.001) {
        toast({
          title: "Insufficient raw stock",
          description: "This edit would make raw-material inventory negative.",
          variant: "destructive",
        });
        return;
      }
      // Current locked USD rate is advisory until the server confirms the review.
      const costPerKg = parseFloat(stock.costPerKgUsd || stock.costPerKg || "0");
      setSelectedSources((prev) => [
        ...prev,
        {
          type: "supplier",
          sourceId: stock.supplierId!,
          label: stock.supplierName,
          weightKg: weight,
          costPerKg,
          totalCost: weight * costPerKg,
          availableKg: available,
        },
      ]);
    } else {
      const b = existingBatches?.find((b) => b.id.toString() === selectedSourceId);
      if (!b) return;
      const available = parseFloat(b.totalWeightKg) - parseFloat(b.usedKg);
      if (weight > available + 0.001) {
        toast({
          title: "Exceeds available",
          description: `Only ${formatNumber(available)} kg available in this batch`,
          variant: "destructive",
        });
        return;
      }
      const costPerKg = parseFloat(b.costPerKg);
      setSelectedSources((prev) => [
        ...prev,
        {
          type: "batch",
          sourceId: b.id,
          label: b.name || b.batchCode,
          weightKg: weight,
          costPerKg,
          totalCost: weight * costPerKg,
          availableKg: available,
        },
      ]);
    }
    setSourceTouched(true);
    setSourceReview(null);
    setSelectedSourceId("");
    setWeightInput("");
  };

  const handleUpdateSourceWeight = (type: string, sourceId: number, newWeight: string) => {
    const weight = Number(newWeight);
    if (!/^\d{1,12}(?:\.\d{1,3})?$/.test(newWeight) || !Number.isFinite(weight) || weight <= 0) return;
    setSourceTouched(true);
    setSourceReview(null);
    setSelectedSources((prev) =>
      prev.map((s) => {
        if (s.type === type && s.sourceId === sourceId) {
          return { ...s, weightKg: weight, totalCost: weight * s.costPerKg };
        }
        return s;
      })
    );
  };

  // Rates are server-authoritative. Source edits change quantities/identity
  // only; no client-side cost override can silently alter a historical value.
  const handleRemoveSource = (type: string, sourceId: number) => {
    setSourceTouched(true);
    setSourceReview(null);
    setSelectedSources((prev) => prev.filter((s) => !(s.type === type && s.sourceId === sourceId)));
  };

  // Two intentionally separate values:
  // 1. Recorded historical: authoritative saved batch cost, independent of today's rates.
  // 2. Prospective edit: the current supplier-rate estimate used by the edit UI.
  const recordedBatchCost = recordedMixBatchCost({
    totalWeightKg: batch?.totalWeightKg,
    totalCost: batch?.totalCost,
    costPerKg: batch?.costPerKg,
  });
  const recordedSourceCost = summarizeRecordedMixSources(currentSources ?? []);
  const savedSourceDifference = Math.abs(recordedSourceCost.totalCost - recordedBatchCost.totalCost);
  const totalWeight = selectedSources.reduce((s, x) => s + x.weightKg, 0);
  const totalCost = selectedSources.reduce((s, x) => s + x.totalCost, 0);
  const blendedCostPerKg = totalWeight > 0 ? totalCost / totalWeight : 0;
  const originalSupplierRates = new Map<number, number>();
  const supplierRecorded = new Map<number, { weightKg: number; totalCost: number }>();
  for (const source of currentSources ?? []) {
    if (source.supplierId == null || source.sourceBatchId != null) continue;
    const existing = supplierRecorded.get(source.supplierId) ?? { weightKg: 0, totalCost: 0 };
    existing.weightKg += Number(source.weightKg) || 0;
    existing.totalCost += Number(source.totalCost) || 0;
    supplierRecorded.set(source.supplierId, existing);
  }
  for (const [supplierId, values] of supplierRecorded) {
    if (values.weightKg > 0) originalSupplierRates.set(supplierId, values.totalCost / values.weightKg);
  }
  const historicalSourcesLocked = batch?.status === "COMPLETED" || batch?.status === "CLOSED";
  const hasMissingCurrentRates =
    !historicalSourcesLocked &&
    selectedSources.some(
      (source) => source.type === "supplier" && (!Number.isFinite(source.costPerKg) || source.costPerKg <= 0)
    );
  const currentUsedKg = batch ? parseFloat(batch.usedKg || "0") : 0;
  // Warn if clearly below used (>1 kg gap). Backend enforces the strict check.
  const belowUsed = totalWeight < currentUsedKg - 1;

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
                  <p className="font-mono font-semibold">${formatNumber(recordedBatchCost.totalCost, 4)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Recorded blended cost/kg</p>
                  <p className="font-mono font-semibold" data-testid="text-edit-recorded-blended-cost">
                    ${recordedBatchCost.costPerKg.toFixed(4)}
                  </p>
                </div>
              </div>
              {currentSources && savedSourceDifference > 0.02 && (
                <p role="alert" className="text-xs text-destructive">
                  Recorded source total differs from the saved batch header by ${formatNumber(savedSourceDifference, 2)}
                  . Review before changing costs.
                </p>
              )}
            </div>
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
            <div className="space-y-3">
              <h3 className="font-medium">Sources</h3>
              {historicalSourcesLocked && (
                <p
                  role="status"
                  className="text-xs text-amber-600 dark:text-amber-400"
                  data-testid="mix-batch-completed-source-lock"
                >
                  Completed batch: source quantities are review-only until historical output and accounting
                  reconciliation (Phases 3–5). Name, date and notes remain editable.
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
                  <Select
                    value={selectedSourceId}
                    disabled={historicalSourcesLocked}
                    onValueChange={handleSourceIdChange}
                  >
                    <SelectTrigger data-testid="select-supplier-source">
                      <SelectValue placeholder="Select supplier" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableSuppliers?.map((stock) => (
                        <SelectItem key={stock.supplierId!} value={stock.supplierId!.toString()}>
                          {stock.supplierName} ({formatNumber(parseFloat(stock.remainingKg))} kg @ $
                          {parseFloat(stock.costPerKgUsd || stock.costPerKg || "0").toFixed(4)}/kg USD)
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
                  <Select
                    value={selectedSourceId}
                    disabled={historicalSourcesLocked}
                    onValueChange={handleSourceIdChange}
                  >
                    <SelectTrigger data-testid="select-batch-source">
                      <SelectValue placeholder="Select batch" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableBatchesForSource?.map((b) => {
                        const remaining = parseFloat(b.totalWeightKg) - parseFloat(b.usedKg);
                        return (
                          <SelectItem key={b.id} value={b.id.toString()}>
                            {b.name || b.batchCode} ({formatNumber(remaining)} kg @ $
                            {parseFloat(b.costPerKg).toFixed(4)}/kg)
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
                  disabled={
                    historicalSourcesLocked || !selectedSourceId || !weightInput || selectedSourceId === "__none__"
                  }
                  data-testid="button-add-source"
                >
                  <Plus className="h-4 w-4 mr-2" /> Add
                </Button>
              </div>
            </div>

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
                                title={historicalSourcesLocked ? "Recorded weighted-average supplier rate at the time of the mix" : "Current supplier rate, used only for an edit estimate"}
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
              <div className="space-y-3 rounded-md border border-border p-4" data-testid="mix-source-edit-review">
                <div>
                  <p className="text-sm font-semibold">Review Material Source Changes</p>
                  <p className="text-xs text-muted-foreground">
                    An explicit review is required before stock allocations can be reversed and reapplied. This review
                    does not modify inventory or create a voucher.
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
                        <p className="font-mono">${formatNumber(Number(sourceReview.recordedTotalCost), 4)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Estimated USD</p>
                        <p className="font-mono">
                          {sourceReview.estimatedTotalCost == null
                            ? "Unavailable"
                            : "$" + formatNumber(Number(sourceReview.estimatedTotalCost), 4)}
                        </p>
                      </div>
                    </div>
                    {sourceReview.estimatedDeltaUsd != null && (
                      <p className="text-xs text-muted-foreground">
                        Estimated valuation difference: ${formatNumber(Number(sourceReview.estimatedDeltaUsd), 4)} USD.
                        The server recalculates the cost during the final transaction.
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
                {saveMutation.isPending ? "Saving…" : sourcesChanged ? "Apply Reviewed Changes" : "Save Changes"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
