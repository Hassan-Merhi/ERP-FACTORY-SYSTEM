import { formatNumber } from "@/lib/formatNumber";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { RecordedCostSummary } from "@/lib/recordedMixBatchCost";
import type { FactoryMixBatch } from "@shared/schema";
import type { StoredMixBatchSource } from "./editMixBatchSources";

interface MixBatchRecordedDetailsDialogProps {
  batch: FactoryMixBatch | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hideCosts: boolean;
  errorMessage?: string | null;
  currentSources: StoredMixBatchSource[] | undefined;
  sourcesLoading: boolean;
  sourcesError: unknown;
  recordedBatchCost: RecordedCostSummary;
}

/**
 * Read-only historical viewer: the saved source rows and recorded batch cost,
 * never today's supplier rates.
 */
export function MixBatchRecordedDetailsDialog({
  batch,
  open,
  onOpenChange,
  hideCosts,
  errorMessage,
  currentSources,
  sourcesLoading,
  sourcesError,
  recordedBatchCost,
}: MixBatchRecordedDetailsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="mix-batch-details-dialog">
        <DialogHeader>
          <DialogTitle>Mix Batch Details — {batch?.batchCode || "Loading…"}</DialogTitle>
          <DialogDescription>
            Recorded historical raw materials and costs, not current supplier prices.
          </DialogDescription>
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
                    <p className="text-sm text-muted-foreground">Recorded Total Cost</p>
                    <p className="text-lg font-semibold font-mono">
                      ${formatNumber(parseFloat(batch?.totalCost || "0"), 4)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Recorded Blended Cost/kg</p>
                    <p className="text-lg font-semibold font-mono" data-testid="text-recorded-blended-cost">
                      ${formatNumber(recordedBatchCost.costPerKg, 4)}
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
