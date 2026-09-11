import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";
import type { MixBatchRow } from "./MixBatchList";
import type { RawStockRow } from "./RawStockTable";

interface AddToBatchPayload {
  batchId: number;
  supplierId: number;
  weightKg: string;
  costPerKg: string;
}

interface MutationLike<TVars> {
  isPending: boolean;
  mutate: (vars: TVars) => void;
}

export interface AddToBatchSource {
  supplierId: number;
  supplierName: string;
  costPerKg: string;
  remainingKg: string;
}

interface AddToBatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  addToBatchSource: AddToBatchSource | null;
  setAddToBatchSource: (source: AddToBatchSource) => void;
  mixBatches: MixBatchRow[];
  rawStock: RawStockRow[];
  addToBatchMutation: MutationLike<AddToBatchPayload>;
  wrapAdminAction: (action: () => void, title: string) => void;
}

export function AddToBatchDialog({
  open,
  onOpenChange,
  addToBatchSource,
  setAddToBatchSource,
  mixBatches,
  rawStock,
  addToBatchMutation,
  wrapAdminAction,
}: AddToBatchDialogProps) {
  const [addToBatchTargetId, setAddToBatchTargetId] = useState("");
  const [addToBatchKg, setAddToBatchKg] = useState("");
  const [addToBatchCost, setAddToBatchCost] = useState("");

  const activeBatches =
    mixBatches?.filter((b) => b.status === "ACTIVE" || b.status === "OPEN" || b.status === "CARRY_FORWARD") ?? [];
  const supplierOptions = rawStock?.filter((r) => r.supplierId && parseFloat(r.freeKg || "0") > 0.001) ?? [];
  const isNoSourcePreset = addToBatchSource === null;
  const selectedSupplierId = addToBatchSource?.supplierId?.toString() || "";

  const handleSupplierChange = (val: string) => {
    const found = rawStock?.find((r) => r.supplierId?.toString() === val);
    if (found && found.supplierId) {
      setAddToBatchSource({
        supplierId: found.supplierId,
        supplierName: found.supplierName,
        costPerKg: String(parseFloat(found.costPerKgUsd ?? "0") || parseFloat(found.costPerKg) || 0),
        remainingKg: found.freeKg || found.remainingKg || "0",
      });
      setAddToBatchCost(String(parseFloat(found.costPerKgUsd ?? "0") || parseFloat(found.costPerKg) || 0));
    }
  };

  const handleSubmit = () => {
    if (!addToBatchSource || !addToBatchTargetId) return;
    addToBatchMutation.mutate({
      batchId: parseInt(addToBatchTargetId),
      supplierId: addToBatchSource.supplierId,
      weightKg: addToBatchKg,
      costPerKg: addToBatchCost,
    });
  };

  const canSubmit =
    !!addToBatchTargetId &&
    addToBatchTargetId !== "__none__" &&
    !!addToBatchKg &&
    !!addToBatchCost &&
    !!addToBatchSource &&
    !addToBatchMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add to Batch</DialogTitle>
          <DialogDescription>
            {addToBatchSource
              ? `Stock from ${addToBatchSource.supplierName} — ${formatNumber(parseFloat(addToBatchSource.remainingKg))} kg free`
              : "Choose the source supplier and target batch."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {isNoSourcePreset && (
            <div className="space-y-2">
              <Label>Source Supplier</Label>
              <Select value={selectedSupplierId} onValueChange={handleSupplierChange}>
                <SelectTrigger data-testid="select-add-to-batch-supplier">
                  <SelectValue placeholder="Select supplier..." />
                </SelectTrigger>
                <SelectContent>
                  {supplierOptions.map((r) => (
                    <SelectItem key={r.supplierId!} value={r.supplierId!.toString()}>
                      {r.supplierName} — {formatNumber(parseFloat(r.freeKg || "0"))} kg free
                    </SelectItem>
                  ))}
                  {supplierOptions.length === 0 && (
                    <SelectItem value="__none__" disabled>
                      No free stock available
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>Target Batch</Label>
            <Select value={addToBatchTargetId} onValueChange={setAddToBatchTargetId}>
              <SelectTrigger data-testid="select-add-to-batch-target">
                <SelectValue placeholder="Select batch..." />
              </SelectTrigger>
              <SelectContent>
                {activeBatches.map((b) => (
                  <SelectItem key={b.id} value={b.id.toString()}>
                    {b.name || b.batchCode} — {formatNumber(parseFloat(b.remainingKg))} kg @ $
                    {parseFloat(b.costPerKg).toFixed(4)}/kg
                  </SelectItem>
                ))}
                {activeBatches.length === 0 && (
                  <SelectItem value="__none__" disabled>
                    No active batches
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Weight to Add (kg)</Label>
            <Input
              type="number"
              step="0.001"
              placeholder={
                addToBatchSource ? `Max ${formatNumber(parseFloat(addToBatchSource.remainingKg))} kg` : "Enter kg"
              }
              value={addToBatchKg}
              onChange={(e) => setAddToBatchKg(e.target.value)}
              data-testid="input-add-to-batch-kg"
            />
          </div>
          <div className="space-y-2">
            <Label>Cost/kg (USD)</Label>
            <Input
              type="number"
              step="0.0001"
              value={addToBatchCost}
              onChange={(e) => setAddToBatchCost(e.target.value)}
              data-testid="input-add-to-batch-cost"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!canSubmit}
              onClick={() => wrapAdminAction(handleSubmit, "Add to Batch")}
              data-testid="button-confirm-add-to-batch"
            >
              {addToBatchMutation.isPending ? "Adding..." : "Add to Batch"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
