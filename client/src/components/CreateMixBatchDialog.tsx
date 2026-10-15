import { getErrorDetails } from "@shared/errorUtils";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { formatNumber } from "@/lib/formatNumber";
import { Plus, Trash2, Layers, Package } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { FactoryMixBatch } from "@shared/schema";
import { MIX_BATCH_TARGET_OPTIONS, selectMixBatchTarget } from "@/pages/factory/production-raw-stock/mixBatchCategoryTargets";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { mixBatchTargetTranslation } from "@/i18n/mixBatchCategoryTargetTranslations";

interface SupplierRawStock {
  supplierName: string;
  supplierId: number | null;
  receivedKg: string;
  usedKg: string;
  remainingKg: string;
  freeKg?: string;
  costPerKg: string;
  costPerKgUsd?: string;
  valueRemaining: string;
  valueRemainingUsd?: string;
  lastOffloaded: string;
}

/**
 * The supplier's rate is the server-authoritative locked raw-material cost/kg
 * (factorySuppliers.currentRawMaterialCostPerKgUsd), returned as costPerKgUsd by
 * GET /api/factory/raw-stock. It never shifts with usage/remaining kg — deriving
 * it from valueRemainingUsd ÷ freeKg would recompute a number that can drift once
 * charges are edited or stock is partially used. This dialog only ever previews
 * that locked rate; it must never send a client-computed cost back to the server.
 */
function getSupplierRate(stock: SupplierRawStock): number {
  return parseFloat(stock.costPerKgUsd || "") || parseFloat(stock.costPerKg || "0");
}

type SourceType = "supplier" | "batch";
type DialogMode = "new" | "topup";

interface SourceSelection {
  type: SourceType;
  sourceId: number;
  label: string;
  weightKg: number;
  costPerKg: number;
  totalCost: number;
  availableKg: number;
}

interface CreateMixBatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (batch: FactoryMixBatch) => void;
}

export function CreateMixBatchDialog({ open, onOpenChange, onCreated }: CreateMixBatchDialogProps) {
  const { toast } = useToast();
  const { language } = useApplicationLanguage();
  const tierText = (key: Parameters<typeof mixBatchTargetTranslation>[0], values?: Record<string, string | number>) => mixBatchTargetTranslation(key, language, values);
  const [mode, setMode] = useState<DialogMode>("new");
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

  // Only show suppliers that still have raw stock available to add to a mix batch.
  const availableSuppliers = supplierStock?.filter((s) => {
    const remaining = parseFloat(s.remainingKg);
    return (
      s.supplierId !== null &&
      remaining > 0 &&
      !selectedSources.some((sel) => sel.type === "supplier" && sel.sourceId === s.supplierId!)
    );
  });

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
        action: (
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
        ),
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const topUpMutation = useMutation({
    mutationFn: async () => {
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

      // Use the same true remaining-value rate as the Raw Stock card (valueRemainingUsd ÷
      // freeKg), not the received-weighted costPerKgUsd — otherwise this preview (and the
      // batch actually created from it) can diverge from what the Raw Stock card shows.
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
            <Button
              type="button"
              variant={mode === "topup" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("topup")}
              data-testid="button-mode-topup"
            >
              Add to Existing Batch
            </Button>
          </div>

          {mode === "new" && (
            <div className="space-y-2" data-testid="mix-batch-production-target-selector">
              <div className="flex flex-wrap items-center gap-2">
                <Label>{tierText("productionTarget")}</Label>
                <span role="status" className="text-xs text-muted-foreground" data-testid="mix-batch-production-target-status">
                  {totalWeight > 0
                    ? tierText("tierLabel", { kg: formatNumber(totalWeight), ton: automaticTargetTons })
                    : tierText("selectSources")}
                </span>
              </div>
              <div className="inline-flex max-w-full rounded-md border border-border bg-muted/40 p-1 gap-1" role="group" aria-label="Automatically selected production target">
                {MIX_BATCH_TARGET_OPTIONS.map((tons) => (
                  <span
                    key={tons}
                    aria-current={automaticTargetTons === tons ? "true" : undefined}
                    className={automaticTargetTons === tons
                      ? "flex min-h-9 min-w-20 items-center justify-center rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-sm"
                      : "flex min-h-9 min-w-20 items-center justify-center rounded-md px-3 text-sm font-semibold text-muted-foreground"}
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
                        {b.name || b.batchCode} — {formatNumber(remaining)} kg remaining @ $
                        {parseFloat(b.costPerKg).toFixed(4)}/kg
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

          <div className="space-y-4">
            <h3 className="font-medium">Add Sources</h3>

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
                data-testid="button-source-type-supplier"
              >
                <Package className="h-3 w-3 mr-1" />
                Supplier Stock
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
                data-testid="button-source-type-batch"
              >
                <Layers className="h-3 w-3 mr-1" />
                Existing Batch
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {addSourceType === "supplier" ? (
                <Select value={selectedSourceId} onValueChange={handleSourceIdChange}>
                  <SelectTrigger data-testid="select-supplier-source">
                    <SelectValue placeholder="Select supplier" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableSuppliers?.map((stock) => (
                      <SelectItem key={stock.supplierId!} value={stock.supplierId!.toString()}>
                        {stock.supplierName} ({formatNumber(parseFloat(stock.remainingKg))} kg @ $
                        {getSupplierRate(stock).toFixed(4)}/kg)
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
                <Select value={selectedSourceId} onValueChange={handleSourceIdChange}>
                  <SelectTrigger data-testid="select-batch-source">
                    <SelectValue placeholder="Select batch" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBatchesForSource?.map((batch) => {
                      const remaining = parseFloat(batch.totalWeightKg) - parseFloat(batch.usedKg);
                      return (
                        <SelectItem key={batch.id} value={batch.id.toString()}>
                          {batch.name || batch.batchCode} ({formatNumber(remaining)} kg @ $
                          {parseFloat(batch.costPerKg).toFixed(4)}/kg)
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
                data-testid="input-source-weight"
              />

              <Button
                type="button"
                onClick={handleAddSource}
                disabled={!selectedSourceId || !weightInput || selectedSourceId === "__none__"}
                data-testid="button-add-source"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add
              </Button>
            </div>
          </div>

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
                      <TableCell className="text-right font-mono">${selection.costPerKg.toFixed(4)}</TableCell>
                      <TableCell className="text-right font-mono">${formatNumber(selection.totalCost)}</TableCell>
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
                ${formatNumber(totalCost)}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Blended Cost/kg</p>
              <p className="text-2xl font-bold font-mono" data-testid="text-cost-per-kg">
                ${blendedCostPerKg.toFixed(4)}
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
