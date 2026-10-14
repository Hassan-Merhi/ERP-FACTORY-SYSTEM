import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { FactoryMixBatch } from "@shared/schema";

interface SupplierRawStock {
  supplierName: string;
  supplierId: number | null;
  receivedKg: string;
  usedKg: string;
  remainingKg: string;
  costPerKg: string;
  costPerKgUsd?: string;
  valueRemaining: string;
  lastOffloaded: string;
}

type SourceType = "supplier" | "batch";

interface SourceSelection {
  type: SourceType;
  sourceId: number;
  label: string;
  weightKg: number;
  costPerKg: number;
  totalCost: number;
  availableKg: number;
}

interface EditMixBatchDialogProps {
  batch: FactoryMixBatch | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Production Overview should display recorded sources without permitting edits. */
  readOnly?: boolean;
  hideCosts?: boolean;
  errorMessage?: string | null;
}

interface StoredMixBatchSource {
  id: number;
  sourceBatchId: number | null;
  sourceBatchCode: string | null;
  supplierId: number | null;
  supplierName: string | null;
  containerNumber: string | null;
  weightKg: string;
  costPerKg: string;
  totalCost: string;
}

export function EditMixBatchDialog({
  batch,
  open,
  onOpenChange,
  readOnly = false,
  hideCosts = false,
  errorMessage,
}: EditMixBatchDialogProps) {
  const { toast } = useToast();
  const [selectedSources, setSelectedSources] = useState<SourceSelection[]>([]);
  const [addSourceType, setAddSourceType] = useState<SourceType>("supplier");
  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [weightInput, setWeightInput] = useState<string>("");
  const [batchName, setBatchName] = useState("");
  const [notes, setNotes] = useState("");
  const [batchDate, setBatchDate] = useState<string>("");
  const [initialized, setInitialized] = useState(false);

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
        // Batch source
        const srcBatch = existingBatches?.find((b) => b.id === src.sourceBatchId);
        const existingRemaining = srcBatch ? parseFloat(srcBatch.totalWeightKg) - parseFloat(srcBatch.usedKg) : 0;
        batchSourceList.push({
          type: "batch",
          sourceId: src.sourceBatchId,
          label: src.sourceBatchCode || `Batch #${src.sourceBatchId}`,
          weightKg: parseFloat(src.weightKg),
          costPerKg: parseFloat(src.costPerKg),
          totalCost: parseFloat(src.totalCost),
          // Available = what's currently available + what this batch is using (returns on edit)
          availableKg: existingRemaining + parseFloat(src.weightKg),
        });
      } else if (src.supplierId) {
        // Supplier source (may span multiple containers — aggregate by supplierId).
        // Cost/kg ALWAYS comes from the current server-authoritative locked rate
        // (GET /api/factory/raw-stock), never from the stored source's historical
        // costPerKg — the locked rate is the single source of truth for a supplier's
        // rate and must be what's previewed/edited-against, not a stale snapshot.
        const existing = supplierMap.get(src.supplierId);
        const stockRow = supplierStock.find((s) => s.supplierId === src.supplierId);
        // Available = current remaining + what was consumed (returns on edit)
        const currentRemaining = stockRow ? parseFloat(stockRow.remainingKg) : 0;
        const currentRate = stockRow ? parseFloat(stockRow.costPerKgUsd || stockRow.costPerKg || "0") : 0;
        const srcWeight = parseFloat(src.weightKg);
        if (existing) {
          existing.weightKg += srcWeight;
          existing.costPerKg = currentRate;
          existing.totalCost = existing.weightKg * existing.costPerKg;
          existing.availableKg = currentRemaining + existing.weightKg;
        } else {
          supplierMap.set(src.supplierId, {
            weightKg: srcWeight,
            costPerKg: currentRate,
            totalCost: srcWeight * currentRate,
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
      totalCost: val.weightKg * val.costPerKg,
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

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Never send costPerKg for supplier sources — the server always applies the
      // supplier's locked rate and ignores any client-supplied cost.
      const supplierSourcesPayload = selectedSources
        .filter((s) => s.type === "supplier")
        .map((s) => ({ supplierId: s.sourceId, weightKg: s.weightKg.toString() }));

      const batchSourcesPayload = selectedSources
        .filter((s) => s.type === "batch")
        .map((s) => ({ sourceBatchId: s.sourceId, weightKg: s.weightKg.toString() }));

      const res = await fetch(`/api/factory/mix-batches/${batch!.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: batchName || undefined,
          notes: notes || undefined,
          batchDate: batchDate || undefined,
          supplierSources: supplierSourcesPayload,
          batchSources: batchSourcesPayload,
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
      onOpenChange(false);
      toast({ title: "Batch updated", description: "Sources and totals have been recalculated." });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      // Over-use allowed: no guard on weight > available
      // Always the current locked rate — never editable, never sent to the server.
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
    setSelectedSourceId("");
    setWeightInput("");
  };

  const handleUpdateSourceWeight = (type: string, sourceId: number, newWeight: string) => {
    const weight = parseFloat(newWeight);
    if (isNaN(weight) || weight <= 0) return;
    setSelectedSources((prev) =>
      prev.map((s) => {
        if (s.type === type && s.sourceId === sourceId) {
          return { ...s, weightKg: weight, totalCost: weight * s.costPerKg };
        }
        return s;
      })
    );
  };

  // Supplier-source cost/kg is never user-editable — it's always the server's locked
  // rate. Only batch sources (using their own historical stored cost) can be edited here.
  const handleUpdateSourceCost = (type: string, sourceId: number, newCostPerKg: string) => {
    if (type !== "batch") return;
    const costPerKg = parseFloat(newCostPerKg);
    if (isNaN(costPerKg) || costPerKg < 0) return;
    setSelectedSources((prev) =>
      prev.map((s) => {
        if (s.type === type && s.sourceId === sourceId) {
          return { ...s, costPerKg, totalCost: s.weightKg * costPerKg };
        }
        return s;
      })
    );
  };

  const handleRemoveSource = (type: string, sourceId: number) => {
    setSelectedSources((prev) => prev.filter((s) => !(s.type === type && s.sourceId === sourceId)));
  };

  const totalWeight = selectedSources.reduce((s, x) => s + x.weightKg, 0);
  const totalCost = selectedSources.reduce((s, x) => s + x.totalCost, 0);
  const blendedCostPerKg = totalWeight > 0 ? totalCost / totalWeight : 0;
  const currentUsedKg = batch ? parseFloat(batch.usedKg || "0") : 0;
  // Warn if clearly below used (>1 kg gap). Backend enforces the strict check.
  const belowUsed = totalWeight < currentUsedKg - 1;

  // Reuse the Raw Materials mix-batch dialog as a safe historical viewer in
  // Production Overview. Display saved source rows, not today's supplier rates:
  // supplier cost/kg can legitimately change after the original mix.
  if (readOnly) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="mix-batch-details-dialog">
          <DialogHeader>
            <DialogTitle>Mix Batch Details — {batch?.batchCode || "Loading…"}</DialogTitle>
            <DialogDescription>Raw materials and existing batches recorded in this mix.</DialogDescription>
          </DialogHeader>
          {!batch && !errorMessage ? (
            <div className="space-y-3 py-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : errorMessage || sourcesError ? (
            <p role="alert" className="py-4 text-sm text-destructive">
              {errorMessage || "Unable to load the recorded sources for this mix batch."}
            </p>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge variant="outline">View only</Badge>
                <span className="font-medium">{batch?.name || "Unnamed batch"}</span>
                <span className="text-muted-foreground">{batch?.batchDate || "No batch date"}</span>
              </div>
              {sourcesLoading ? (
                <div className="space-y-3 py-4">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : !currentSources?.length ? (
                <p className="py-4 text-sm text-muted-foreground">No recorded source materials found for this batch.</p>
              ) : (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Source / Container</TableHead>
                        <TableHead className="text-right">Weight (kg)</TableHead>
                        {!hideCosts && <TableHead className="text-right">Cost/kg</TableHead>}
                        {!hideCosts && <TableHead className="text-right">Total Cost</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {currentSources.map((source) => (
                        <TableRow key={source.id} data-testid={`mix-batch-source-${source.id}`}>
                          <TableCell>
                            <Badge variant={source.sourceBatchId ? "secondary" : "outline"}>
                              {source.sourceBatchId ? "Batch" : "Supplier"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">
                              {source.sourceBatchId
                                ? source.sourceBatchCode || `Batch #${source.sourceBatchId}`
                                : source.supplierName ||
                                  (source.supplierId ? `Supplier #${source.supplierId}` : "Raw material")}
                            </div>
                            {source.containerNumber && (
                              <div className="text-xs text-muted-foreground">Container: {source.containerNumber}</div>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatNumber(parseFloat(source.weightKg) || 0, 3)}
                          </TableCell>
                          {!hideCosts && (
                            <TableCell className="text-right font-mono text-sm">
                              ${formatNumber(parseFloat(source.costPerKg) || 0, 4)}
                            </TableCell>
                          )}
                          {!hideCosts && (
                            <TableCell className="text-right font-mono text-sm">
                              ${formatNumber(parseFloat(source.totalCost) || 0, 4)}
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <div
                className={`grid gap-3 rounded-md bg-muted p-4 ${hideCosts ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-3"}`}
              >
                <div>
                  <p className="text-sm text-muted-foreground">Total Weight</p>
                  <p className="text-lg font-semibold font-mono">
                    {formatNumber(parseFloat(batch?.totalWeightKg || "0"), 3)} kg
                  </p>
                </div>
                {!hideCosts && (
                  <>
                    <div>
                      <p className="text-sm text-muted-foreground">Total Cost</p>
                      <p className="text-lg font-semibold font-mono">
                        ${formatNumber(parseFloat(batch?.totalCost || "0"), 4)}
                      </p>
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Blended Cost/kg</p>
                      <p className="text-lg font-semibold font-mono">
                        ${formatNumber(parseFloat(batch?.costPerKg || "0"), 4)}
                      </p>
                    </div>
                  </>
                )}
              </div>
              {batch?.notes && (
                <div className="space-y-1">
                  <Label>Notes</Label>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{batch.notes}</p>
                </div>
              )}
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Mix Batch — {batch?.batchCode}</DialogTitle>
          <DialogDescription>
            Change the raw material sources. Old consumption will be reversed and new amounts will be consumed.
            Already-produced bales ({formatNumber(currentUsedKg)} kg used) must remain covered.
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
                  onChange={(e) => setBatchDate(e.target.value)}
                  data-testid="input-edit-batch-date"
                />
              </div>
            </div>

            {/* Add source controls */}
            <div className="space-y-3">
              <h3 className="font-medium">Sources</h3>
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
                  data-testid="button-source-type-batch"
                >
                  <Layers className="h-3 w-3 mr-1" /> Existing Batch
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
                          {parseFloat(stock.costPerKg).toFixed(4)}/kg)
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
                  data-testid="input-source-weight"
                />

                <Button
                  type="button"
                  onClick={handleAddSource}
                  disabled={!selectedSourceId || !weightInput || selectedSourceId === "__none__"}
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
                      <TableHead className="text-right">Cost/kg</TableHead>
                      <TableHead className="text-right">Total Cost</TableHead>
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
                            data-testid={`input-weight-${sel.type}-${sel.sourceId}`}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          {sel.type === "supplier" ? (
                            // Supplier rate is always the server-locked rate — read-only,
                            // it only changes via a real container offload/correction.
                            <span
                              className="font-mono text-xs text-muted-foreground"
                              data-testid={`text-cost-per-kg-${sel.type}-${sel.sourceId}`}
                              title="Locked supplier rate — only changes via a container offload or an explicit correction"
                            >
                              ${sel.costPerKg.toFixed(4)}
                            </span>
                          ) : (
                            <div className="relative ml-auto w-28">
                              <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                                $
                              </span>
                              <Input
                                type="number"
                                className="h-7 w-28 pl-4 text-right font-mono text-xs"
                                value={sel.costPerKg.toFixed(4)}
                                step="0.0001"
                                min="0"
                                onChange={(e) => handleUpdateSourceCost(sel.type, sel.sourceId, e.target.value)}
                                data-testid={`input-cost-per-kg-${sel.type}-${sel.sourceId}`}
                              />
                            </div>
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
                <p className="text-sm text-muted-foreground">Total Cost</p>
                <p className="text-2xl font-bold font-mono">${formatNumber(totalCost, 4)}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Blended Cost/kg</p>
                <p className="text-2xl font-bold font-mono">${blendedCostPerKg.toFixed(4)}</p>
              </div>
            </div>

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

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-edit">
                Cancel
              </Button>
              <Button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || selectedSources.length === 0}
                data-testid="button-save-edit"
              >
                {saveMutation.isPending ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
