// Extracted from ./SmartTransferGeneratorDialog.tsx to keep that module under the source-size cap.
import { AlertCircle, Plus, Sparkles } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSmartTransferGeneratorDialogState } from "./useSmartTransferGeneratorDialogState";
import { SmartTransferGeneratorDialogSectionTableBody } from "./SmartTransferGeneratorDialogSectionTableBody";

export function SmartTransferGeneratorDialogSection({
  addManualLine,
  editedShortfall,
  editedTotal,
  expandedLineIds,
  getInventory,
  lines,
  manualItemId,
  manualQuantity,
  manualSourceId,
  preview,
  setExpandedLineIds,
  setLines,
  setManualItemId,
  setManualQuantity,
  setManualSourceId,
  sourceLocationIds,
  sourceNameById,
  stockItems,
  target,
  updateLineQuantity,
  updateLineSource,
  validationErrors,
}: Pick<
  ReturnType<typeof useSmartTransferGeneratorDialogState>,
  | "addManualLine"
  | "editedShortfall"
  | "editedTotal"
  | "expandedLineIds"
  | "getInventory"
  | "lines"
  | "manualItemId"
  | "manualQuantity"
  | "manualSourceId"
  | "preview"
  | "setExpandedLineIds"
  | "setLines"
  | "setManualItemId"
  | "setManualQuantity"
  | "setManualSourceId"
  | "sourceLocationIds"
  | "sourceNameById"
  | "stockItems"
  | "target"
  | "updateLineQuantity"
  | "updateLineSource"
  | "validationErrors"
>) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      {!preview ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground">
          <Sparkles className="mb-4 h-12 w-12 opacity-40" />
          <p className="font-medium text-foreground">Choose the destination, sources and target quantity</p>
          <p className="mt-1 max-w-lg text-sm">
            The generator will return an editable preview only. It will not create a voucher or move stock.
          </p>
        </div>
      ) : (
        <>
          <div className="border-b p-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Requested</p>
                <p className="text-xl font-semibold">{formatNumber(target, 0)}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Preview total</p>
                <p className="text-xl font-semibold">{formatNumber(editedTotal, 0)}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Shortfall</p>
                <p className={cn("text-xl font-semibold", editedShortfall > 0 && "text-amber-600")}>
                  {formatNumber(editedShortfall, 0)}
                </p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Suggested lines</p>
                <p className="text-xl font-semibold">{lines.length}</p>
              </div>
            </div>

            {(preview.warnings.length > 0 || validationErrors.length > 0) && (
              <div className="mt-3 space-y-2">
                {[...preview.warnings, ...validationErrors].map((warning, index) => (
                  <div
                    key={`${warning}-${index}`}
                    className="flex items-start gap-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
                  >
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{warning}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-20 bg-background">
                <TableRow>
                  <TableHead className="w-9"></TableHead>
                  <TableHead className="min-w-[190px]">Item</TableHead>
                  <TableHead className="min-w-[150px]">Source</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead className="text-right">Last 2 sent</TableHead>
                  <TableHead className="text-right">Sold since</TableHead>
                  <TableHead className="text-right">Dest + OTW</TableHead>
                  <TableHead className="w-28 text-right">Suggested</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <SmartTransferGeneratorDialogSectionTableBody
                expandedLineIds={expandedLineIds}
                getInventory={getInventory}
                lines={lines}
                setExpandedLineIds={setExpandedLineIds}
                setLines={setLines}
                sourceLocationIds={sourceLocationIds}
                sourceNameById={sourceNameById}
                updateLineQuantity={updateLineQuantity}
                updateLineSource={updateLineSource}
              />
            </Table>
          </div>

          <div className="border-t p-4">
            <div className="mb-2 flex items-center gap-2">
              <Plus className="h-4 w-4" />
              <p className="text-sm font-medium">Add another item manually</p>
            </div>
            <div className="grid gap-2 md:grid-cols-[minmax(180px,1fr)_minmax(150px,220px)_100px_auto]">
              <Select value={manualItemId?.toString() ?? ""} onValueChange={(value) => setManualItemId(Number(value))}>
                <SelectTrigger>
                  <SelectValue placeholder="Stock item" />
                </SelectTrigger>
                <SelectContent>
                  {stockItems.map((item) => (
                    <SelectItem key={item.id} value={item.id.toString()}>
                      {item.name} ({item.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={manualSourceId?.toString() ?? ""}
                onValueChange={(value) => setManualSourceId(Number(value))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  {sourceLocationIds.map((sourceId) => (
                    <SelectItem key={sourceId} value={sourceId.toString()}>
                      {sourceNameById.get(sourceId)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                type="number"
                min="1"
                step="1"
                value={manualQuantity}
                onChange={(event) => setManualQuantity(event.target.value)}
              />
              <Button type="button" variant="outline" onClick={addManualLine}>
                <Plus className="mr-1 h-4 w-4" /> Add
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
