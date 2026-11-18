// Extracted from ./EditMixBatchDialog.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { formatNumber } from "@/lib/formatNumber";
import { recordedMixBatchCost, summarizeRecordedMixSources } from "@/lib/recordedMixBatchCost";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { FactoryMixBatch } from "@shared/schema";
import {
  type EditMixBatchDialogProps,
  hasChangedSourceWeights,
  type SourceEditReview,
  type SourceSelection,
  type SourceType,
  type StoredMixBatchSource,
  type SupplierRawStock,
} from "./editMixBatchSources";

export function useEditMixBatchDialogState({
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
            ? existing.weightKg > 0
              ? existing.totalCost / existing.weightKg
              : 0
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
  return {
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
  };
}
