// Extracted from ./CreateMixBatchDialog.tsx to keep that module under the source-size cap.
import { formatNumber } from "@/lib/formatNumber";
import { Layers, Package, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getSupplierRate } from "./CreateMixBatchDialogTypes";
import { useCreateMixBatchDialogState } from "./useCreateMixBatchDialogState";

export function CreateMixBatchDialogSection({
  addSourceType,
  availableBatchesForSource,
  availableSuppliers,
  handleAddSource,
  handleSourceIdChange,
  selectedSourceId,
  setAddSourceType,
  setSelectedSourceId,
  setWeightInput,
  weightInput,
}: Pick<
  ReturnType<typeof useCreateMixBatchDialogState>,
  | "addSourceType"
  | "availableBatchesForSource"
  | "availableSuppliers"
  | "handleAddSource"
  | "handleSourceIdChange"
  | "selectedSourceId"
  | "setAddSourceType"
  | "setSelectedSourceId"
  | "setWeightInput"
  | "weightInput"
>) {
  return (
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
  );
}
