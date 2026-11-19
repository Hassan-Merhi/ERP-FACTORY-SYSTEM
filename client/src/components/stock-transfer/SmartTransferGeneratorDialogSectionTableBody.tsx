// Extracted from ./SmartTransferGeneratorDialogSection.tsx
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableBody, TableCell, TableRow } from "@/components/ui/table";
import { classificationBadge, useSmartTransferGeneratorDialogState } from "./useSmartTransferGeneratorDialogState";

export function SmartTransferGeneratorDialogSectionTableBody({
  expandedLineIds,
  getInventory,
  lines,
  setExpandedLineIds,
  setLines,
  sourceLocationIds,
  sourceNameById,
  updateLineQuantity,
  updateLineSource,
}: Pick<
  Pick<
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
  >,
  | "expandedLineIds"
  | "getInventory"
  | "lines"
  | "setExpandedLineIds"
  | "setLines"
  | "sourceLocationIds"
  | "sourceNameById"
  | "updateLineQuantity"
  | "updateLineSource"
>) {
  return (
    <TableBody>
      {lines.map((line) => {
        const expanded = expandedLineIds.has(line.clientId);
        return (
          <>
            <TableRow key={line.clientId}>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() =>
                    setExpandedLineIds((current) => {
                      const next = new Set(current);
                      next.has(line.clientId) ? next.delete(line.clientId) : next.add(line.clientId);
                      return next;
                    })
                  }
                >
                  {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </Button>
              </TableCell>
              <TableCell>
                <div className="space-y-1">
                  <p className="font-medium">{line.stockItemName}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{line.stockItemCode}</span>
                    <Badge variant="outline" className={cn("text-[11px]", classificationBadge(line.classification))}>
                      {line.classificationLabel}
                    </Badge>
                    {line.manual && (
                      <Badge variant="secondary" className="text-[11px]">
                        Manual
                      </Badge>
                    )}
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Select
                  value={line.sourceLocationId.toString()}
                  onValueChange={(value) => updateLineSource(line.clientId, Number(value))}
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sourceLocationIds.map((sourceId) => {
                      const inventory = getInventory(line.stockItemId, sourceId);
                      return (
                        <SelectItem key={sourceId} value={sourceId.toString()} disabled={inventory.available <= 0}>
                          {sourceNameById.get(sourceId)} ({inventory.available})
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="text-right font-mono">{formatNumber(line.availableAtSource, 0)}</TableCell>
              <TableCell className="text-right font-mono">
                {formatNumber(line.olderTransferQty + line.newerTransferQty, 0)}
              </TableCell>
              <TableCell className="text-right font-mono">
                {formatNumber(line.totalSalesSinceOlderTransfer, 0)}
              </TableCell>
              <TableCell className="text-right font-mono">{formatNumber(line.effectiveDestinationStock, 0)}</TableCell>
              <TableCell>
                <Input
                  className="h-8 text-right font-mono"
                  type="number"
                  min="0"
                  step="1"
                  value={line.suggestedQuantity}
                  onChange={(event) => updateLineQuantity(line.clientId, event.target.value)}
                />
              </TableCell>
              <TableCell>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() =>
                    setLines((current) => current.filter((candidate) => candidate.clientId !== line.clientId))
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
            {expanded && (
              <TableRow key={`${line.clientId}-details`} className="bg-muted/30">
                <TableCell></TableCell>
                <TableCell colSpan={8}>
                  <div className="grid gap-3 py-2 text-xs md:grid-cols-4">
                    <div>
                      <span className="text-muted-foreground">Older transfer:</span>{" "}
                      {formatNumber(line.olderTransferQty, 0)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Newer transfer:</span>{" "}
                      {formatNumber(line.newerTransferQty, 0)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Older sell-through:</span>{" "}
                      {formatNumber(line.olderSellThroughPercentage, 1)}%
                    </div>
                    <div>
                      <span className="text-muted-foreground">Newer sell-through:</span>{" "}
                      {formatNumber(line.newerSellThroughPercentage, 1)}%
                    </div>
                    <div>
                      <span className="text-muted-foreground">Latest sales/day:</span>{" "}
                      {formatNumber(line.latestSalesPerDay, 2)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Calculated need:</span>{" "}
                      {formatNumber(line.calculatedNeed, 0)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Confidence:</span>{" "}
                      {formatNumber(line.confidence * 100, 0)}%
                    </div>
                    <p className="md:col-span-4 text-muted-foreground">{line.reason}</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </>
        );
      })}
      {lines.length === 0 && (
        <TableRow>
          <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
            No suggested lines. Adjust the filters, sources or target and regenerate.
          </TableCell>
        </TableRow>
      )}
    </TableBody>
  );
}
