import { Check, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useSmartTransferGeneratorDialogState,
  type SmartTransferGeneratorDialogProps,
} from "./useSmartTransferGeneratorDialogState";
import { SmartTransferGeneratorDialogSection } from "./SmartTransferGeneratorDialogSection";
import { MultiSelectPopover } from "./MultiSelectPopover";

export default function SmartTransferGeneratorDialog(props: SmartTransferGeneratorDialogProps) {
  const {
    addManualLine,
    categories,
    categoryIds,
    destinationLocationId,
    editedShortfall,
    editedTotal,
    expandedLineIds,
    getInventory,
    importPreview,
    includeOtw,
    lines,
    locations,
    manualItemId,
    manualQuantity,
    manualSourceId,
    onOpenChange,
    open,
    preview,
    previewMutation,
    setCategoryIds,
    setDestinationLocationId,
    setExpandedLineIds,
    setIncludeOtw,
    setLines,
    setManualItemId,
    setManualQuantity,
    setManualSourceId,
    setStockGroupIds,
    setTargetCoverageDays,
    setTargetQuantity,
    sourceLocationIds,
    sourceNameById,
    stockGroupIds,
    stockGroups,
    stockItems,
    target,
    targetCoverageDays,
    targetQuantity,
    toggleSource,
    updateLineQuantity,
    updateLineSource,
    validationErrors,
  } = useSmartTransferGeneratorDialogState(props);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[92vh] w-[96vw] max-w-7xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Smart Multi-Source Transfer Generator
          </DialogTitle>
          <DialogDescription>
            Compares the last two completed transfers, sales since those orders, live source stock and optional OTW
            stock.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[330px_minmax(0,1fr)]">
          <div className="overflow-y-auto border-b p-4 lg:border-b-0 lg:border-r">
            <div className="space-y-5">
              <div className="space-y-2">
                <Label>Destination</Label>
                <Select
                  value={destinationLocationId?.toString() ?? ""}
                  onValueChange={(value) => setDestinationLocationId(Number(value))}
                >
                  <SelectTrigger data-testid="smart-transfer-destination">
                    <SelectValue placeholder="Select destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((location) => (
                      <SelectItem key={location.id} value={location.id.toString()}>
                        {location.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Source locations</Label>
                  <span className="text-xs text-muted-foreground">{sourceLocationIds.length} selected</span>
                </div>
                <ScrollArea className="h-48 rounded-md border">
                  <div className="space-y-1 p-2">
                    {locations.map((location) => {
                      const disabled = location.id === destinationLocationId;
                      return (
                        <label
                          key={location.id}
                          className={cn(
                            "flex items-center gap-2 rounded-md px-2 py-2",
                            disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer hover:bg-muted"
                          )}
                        >
                          <Checkbox
                            checked={sourceLocationIds.includes(location.id)}
                            disabled={disabled}
                            onCheckedChange={() => toggleSource(location.id)}
                          />
                          <span className="text-sm">{location.name}</span>
                          <span className="ml-auto text-xs text-muted-foreground">{location.code}</span>
                        </label>
                      );
                    })}
                  </div>
                </ScrollArea>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="smart-target">
                    Target bales <span className="text-xs font-normal text-muted-foreground">(blank = auto)</span>
                  </Label>
                  <Input
                    id="smart-target"
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Auto from sales"
                    value={targetQuantity}
                    onChange={(event) => setTargetQuantity(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="smart-coverage">Target coverage days</Label>
                <Input
                  id="smart-coverage"
                  type="number"
                  min="1"
                  max="180"
                  step="1"
                  value={targetCoverageDays}
                  onChange={(event) => setTargetCoverageDays(event.target.value)}
                />
              </div>

              <MultiSelectPopover
                label="stock groups"
                items={stockGroups}
                selected={stockGroupIds}
                onChange={setStockGroupIds}
              />
              <MultiSelectPopover
                label="categories"
                items={categories}
                selected={categoryIds}
                onChange={setCategoryIds}
              />

              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Include Stock OTW</p>
                  <p className="text-xs text-muted-foreground">Reduces suggestions already covered on the way</p>
                </div>
                <Switch checked={includeOtw} onCheckedChange={setIncludeOtw} />
              </div>

              <Button
                className="w-full"
                onClick={() => previewMutation.mutate()}
                disabled={previewMutation.isPending || !destinationLocationId || sourceLocationIds.length === 0}
                data-testid="button-generate-smart-preview"
              >
                {previewMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="mr-2 h-4 w-4" />
                )}
                Generate Preview
              </Button>
            </div>
          </div>

          <SmartTransferGeneratorDialogSection
            addManualLine={addManualLine}
            editedShortfall={editedShortfall}
            editedTotal={editedTotal}
            expandedLineIds={expandedLineIds}
            getInventory={getInventory}
            lines={lines}
            manualItemId={manualItemId}
            manualQuantity={manualQuantity}
            manualSourceId={manualSourceId}
            preview={preview}
            setExpandedLineIds={setExpandedLineIds}
            setLines={setLines}
            setManualItemId={setManualItemId}
            setManualQuantity={setManualQuantity}
            setManualSourceId={setManualSourceId}
            sourceLocationIds={sourceLocationIds}
            sourceNameById={sourceNameById}
            stockItems={stockItems}
            target={target}
            updateLineQuantity={updateLineQuantity}
            updateLineSource={updateLineSource}
            validationErrors={validationErrors}
          />
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {preview && (
            <Button
              type="button"
              variant="outline"
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
            >
              <RefreshCw className={cn("mr-2 h-4 w-4", previewMutation.isPending && "animate-spin")} />
              Regenerate
            </Button>
          )}
          <Button
            type="button"
            onClick={importPreview}
            disabled={!preview || lines.length === 0 || validationErrors.length > 0}
            data-testid="button-import-smart-preview"
          >
            <Check className="mr-2 h-4 w-4" />
            Import to Optional Order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
