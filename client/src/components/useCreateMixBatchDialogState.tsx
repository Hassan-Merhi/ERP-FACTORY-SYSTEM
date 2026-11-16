// Extracted from ./CreateMixBatchDialog.tsx to keep that module under the source-size cap.
import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { formatNumber } from "@/lib/formatNumber";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { FactoryMixBatch } from "@shared/schema";
import { selectMixBatchTarget } from "@/pages/factory/production-raw-stock/mixBatchCategoryTargets";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { mixBatchTargetTranslation } from "@/i18n/mixBatchCategoryTargetTranslations";
import {
  getSupplierRate,
  type CreateMixBatchDialogProps,
  type DialogMode,
  type SourceSelection,
  type SourceType,
  type SupplierRawStock,
} from "./CreateMixBatchDialogTypes";

export function useCreateMixBatchDialogState({ open, onOpenChange, onCreated }: CreateMixBatchDialogProps) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tierText = (key: Parameters<typeof mixBatchTargetTranslation>[0], values?: Record<string, string | number>) =>
    mixBatchTargetTranslation(key, language, values);
  const [mode, setMode] = useState<DialogMode>("new");
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateBatch = recordChanges.canCreate("POST", "/api/factory/mix-batches");
  // Topping up and undoing change an existing batch, which read-only roles never do.
  const canSubmitMode = mode === "topup" ? recordChanges.allowed : canCreateBatch;
  const [targetBatchId, setTargetBatchId] = useState<string>("");
  const [selectedSources, setSelectedSources] = useState<SourceSelection[]>([]);
  const [addSourceType, setAddSourceType] = useState<SourceType>("supplier");
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [weightInput, setWeightInput] = useState<string>("");
  const [batchName, setBatchName] = useState("");
  const [notes, setNotes] = useState("");
  const [batchDate, setBatchDate] = useState<string>(new Date().toLocaleDateString("en-CA"));

  const { data: supplierStock } = useQuery<SupplierRawStock[]>({
    queryKey: ["/api/factory/raw-stock"],
    enabled: open,
  });

  const { data: existingBatches } = useQuery<FactoryMixBatch[]>({
    queryKey: ["/api/factory/mix-batches"],
    enabled: open,
  });

  // A supplier with an established USD cost may be used while its stock is
  // temporarily negative: the next same-supplier offload nets the shortage.
  // Do not hide suppliers merely because remainingKg is zero or negative.
  const availableSuppliers = supplierStock?.filter(
    (s) =>
      s.supplierId !== null &&
      getSupplierRate(s) > 0 &&
      !selectedSources.some((sel) => sel.type === "supplier" && sel.sourceId === s.supplierId!)
  );

  const availableBatchesForSource = existingBatches?.filter((b) => {
    const remaining = parseFloat(b.totalWeightKg) - parseFloat(b.usedKg);
    return (
      remaining > 0.001 &&
      (b.status === "ACTIVE" || b.status === "OPEN" || b.status === "CARRY_FORWARD") &&
      !selectedSources.some((sel) => sel.type === "batch" && sel.sourceId === b.id)
    );
  });

  const activeBatchesForTopup =
    existingBatches?.filter((b) => {
      return b.status === "ACTIVE" || b.status === "OPEN" || b.status === "CARRY_FORWARD";
    }) ?? [];

  const createMutation = useMutation({
    mutationFn: async () => {
      // Never send costPerKg for supplier sources — the server always uses the
      // supplier's locked rate; any client-supplied cost is ignored server-side.
      const supplierSources = selectedSources
        .filter((s) => s.type === "supplier")
        .map((s) => ({
          supplierId: s.sourceId,
          weightKg: s.weightKg.toString(),
        }));

      const batchSources = selectedSources
        .filter((s) => s.type === "batch")
        .map((s) => ({
          sourceBatchId: s.sourceId,
          weightKg: s.weightKg.toString(),
        }));

      const response = await fetch("/api/factory/mix-batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: batchName || undefined,
          notes: notes || undefined,
          batchDate: batchDate || undefined,
          supplierSources: supplierSources.length > 0 ? supplierSources : undefined,
          batchSources: batchSources.length > 0 ? batchSources : undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to create batch");
      }

      return await response.json();
    },
    onSuccess: (result: FactoryMixBatch) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      onCreated?.(result);
      handleClose();
      const batchId = result.id;
      const batchCode = result.batchCode || `#${batchId}`;
      toast({
        title: "Batch created",
        description: `${batchCode} created successfully`,
        action: recordChanges.allowed ? (
          <ToastAction
            altText="Undo"
            onClick={async () => {
              try {
                const res = await fetch(`/api/factory/mix-batches/${batchId}`, { method: "DELETE" });
                if (!res.ok) throw new Error((await res.json()).message);
                queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
                queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
                toast({ title: "Undone", description: `${batchCode} has been reversed` });
              } catch (e) {
                toast({ title: "Undo failed", description: getErrorDetails(e).message, variant: "destructive" });
              }
            }}
          >
            Undo
          </ToastAction>
        ) : undefined,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const topUpMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!targetBatchId) throw new Error("Please select a batch to add to");

      // Never send costPerKg for supplier sources — the server always uses the
      // supplier's locked rate; any client-supplied cost is ignored server-side.
      const supplierSources = selectedSources
        .filter((s) => s.type === "supplier")
        .map((s) => ({
          supplierId: s.sourceId,
          weightKg: s.weightKg.toString(),
        }));

      const batchSources = selectedSources
        .filter((s) => s.type === "batch")
        .map((s) => ({
          sourceBatchId: s.sourceId,
          weightKg: s.weightKg.toString(),
        }));

      const response = await fetch(`/api/factory/mix-batches/${targetBatchId}/top-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          txDate: batchDate || undefined,
          supplierSources: supplierSources.length > 0 ? supplierSources : undefined,
          batchSources: batchSources.length > 0 ? batchSources : undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to add to batch");
      }

      return await response.json();
    },
    onSuccess: (result: FactoryMixBatch) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      handleClose();
      const batchCode = result.batchCode || `#${result.id}`;
      toast({
        title: "Added to batch",
        description: `${formatNumber(selectedSources.reduce((s, x) => s + x.weightKg, 0))} kg added to ${batchCode}`,
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleSourceIdChange = (id: string) => {
    setSelectedSourceId(id);
    if (addSourceType === "supplier") {
      const stock = supplierStock?.find((s) => s.supplierId?.toString() === id);
      if (stock) {
        // Only prefill if remaining is positive; leave blank to let user enter their own for over-use
        const rem = parseFloat(stock.remainingKg);
        setWeightInput(rem > 0 ? stock.remainingKg : "");
      }
    } else {
      const batch = existingBatches?.find((b) => b.id.toString() === id);
      if (batch) {
        const remaining = parseFloat(batch.totalWeightKg) - parseFloat(batch.usedKg);
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
      // Over-use allowed: no guard on weight > available

      // Preview the persisted supplier USD rate. Negative stock must not
      // create a zero-rate or client-supplied historical cost.
      const costPerKg = getSupplierRate(stock);
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
      const batch = existingBatches?.find((b) => b.id.toString() === selectedSourceId);
      if (!batch) return;

      const available = parseFloat(batch.totalWeightKg) - parseFloat(batch.usedKg);
      if (weight > available + 0.001) {
        toast({
          title: "Exceeds available",
          description: `Only ${formatNumber(available)} kg available in this batch`,
          variant: "destructive",
        });
        return;
      }

      const costPerKg = parseFloat(batch.costPerKg);
      setSelectedSources((prev) => [
        ...prev,
        {
          type: "batch",
          sourceId: batch.id,
          label: batch.name || batch.batchCode,
          weightKg: weight,
          costPerKg,
          totalCost: weight * costPerKg,
          availableKg: available,
        },
      ]);
    }

    setSelectedSourceId("");
    setWeightInput("");
  };

  const handleRemoveSource = (type: string, sourceId: number) => {
    setSelectedSources((prev) => prev.filter((s) => !(s.type === type && s.sourceId === sourceId)));
  };

  const handleClose = () => {
    onOpenChange(false);
    setMode("new");
    setTargetBatchId("");
    setSelectedSources([]);
    setSelectedSourceId("");
    setWeightInput("");
    setBatchName("");
    setNotes("");
    setBatchDate(new Date().toLocaleDateString("en-CA"));
    setAddSourceType("supplier");
  };

  const totalWeight = selectedSources.reduce((sum, s) => sum + s.weightKg, 0);
  const totalCost = selectedSources.reduce((sum, s) => sum + s.totalCost, 0);
  const blendedCostPerKg = totalWeight > 0 ? totalCost / totalWeight : 0;
  const automaticTargetTons = selectMixBatchTarget(totalWeight);
  const hasAnySources = selectedSources.length > 0;
  const isPending = createMutation.isPending || topUpMutation.isPending;
  return {
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
  };
}
