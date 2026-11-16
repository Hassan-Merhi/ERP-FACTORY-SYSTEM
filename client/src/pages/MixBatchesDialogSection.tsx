// Extracted from ./MixBatches.tsx to keep that module under the source-size cap.
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/formatNumber";
import { useMixBatchesState } from "./useMixBatchesState";

export function MixBatchesDialogSection({
  activeBatchesWithStock,
  assignDialogOpen,
  assignMutation,
  availableKg,
  overLimit,
  selectedBaleIds,
  selectedKg,
  setAssignDialogOpen,
  setSelectedBaleIds,
  setSourceBatchId,
  sourceBatch,
  sourceBatchId,
  unlinkedBales,
}: Pick<
  ReturnType<typeof useMixBatchesState>,
  | "activeBatchesWithStock"
  | "assignDialogOpen"
  | "assignMutation"
  | "availableKg"
  | "overLimit"
  | "selectedBaleIds"
  | "selectedKg"
  | "setAssignDialogOpen"
  | "setSelectedBaleIds"
  | "setSourceBatchId"
  | "sourceBatch"
  | "sourceBatchId"
  | "unlinkedBales"
>) {
  return (
    <Dialog
      open={assignDialogOpen}
      onOpenChange={(open) => {
        setAssignDialogOpen(open);
        if (!open) {
          setSourceBatchId("");
          setSelectedBaleIds(new Set());
        }
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Assign Raw Stock to Bales</DialogTitle>
          <DialogDescription>
            Choose which batch is the raw stock source, then select the bales to assign it to.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Step 1 — Select raw stock (batch)</p>
            {activeBatchesWithStock.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No batches with remaining stock found. Create a batch first.
              </p>
            ) : (
              <Select
                value={sourceBatchId}
                onValueChange={(v) => {
                  setSourceBatchId(v);
                  setSelectedBaleIds(new Set());
                }}
              >
                <SelectTrigger data-testid="select-source-batch">
                  <SelectValue placeholder="Pick a batch…" />
                </SelectTrigger>
                <SelectContent>
                  {activeBatchesWithStock.map((b) => {
                    const rem = parseFloat(b.totalWeightKg || "0") - parseFloat(b.usedKg || "0");
                    return (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.name || b.batchCode} — {formatNumber(rem)} kg left
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
            {sourceBatch && (
              <p className="text-xs text-muted-foreground">
                Available: <span className="font-mono font-medium text-foreground">{formatNumber(availableKg)} kg</span>
                {" · "}Cost/kg:{" "}
                <span className="font-mono font-medium text-foreground">
                  ${parseFloat(sourceBatch.costPerKg || "0").toFixed(4)}
                </span>
              </p>
            )}
          </div>

          {sourceBatchId && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Step 2 — Select bales to assign</p>
                {unlinkedBales && unlinkedBales.length > 0 && (
                  <span className="text-xs text-muted-foreground flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1 text-xs"
                      onClick={() => setSelectedBaleIds(new Set(unlinkedBales.map((b) => b.id)))}
                    >
                      All
                    </Button>
                    /
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1 text-xs"
                      onClick={() => setSelectedBaleIds(new Set())}
                    >
                      None
                    </Button>
                  </span>
                )}
              </div>

              {selectedBaleIds.size > 0 && (
                <p className={`text-xs ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                  {selectedBaleIds.size} bales · {formatNumber(selectedKg)} kg selected (
                  {formatNumber(availableKg - selectedKg)} kg remaining after)
                </p>
              )}

              <div className="max-h-64 overflow-y-auto border rounded-md">
                {!unlinkedBales ? (
                  <div className="p-4 space-y-2">
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : unlinkedBales.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground text-sm">
                    No unlinked bales found — all pressed bales already have a raw stock source.
                  </div>
                ) : (
                  <Table mobileLayout="cards">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10"></TableHead>
                        <TableHead>Bale Code</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead className="text-right">Weight (kg)</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {unlinkedBales.map((bale) => (
                        <TableRow
                          key={bale.id}
                          className="cursor-pointer"
                          onClick={() =>
                            setSelectedBaleIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(bale.id)) next.delete(bale.id);
                              else next.add(bale.id);
                              return next;
                            })
                          }
                          data-testid={`row-unlinked-bale-${bale.id}`}
                        >
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={selectedBaleIds.has(bale.id)}
                              readOnly
                              className="cursor-pointer"
                            />
                          </TableCell>
                          <TableCell className="font-mono text-sm">{bale.baleCode}</TableCell>
                          <TableCell className="text-sm">{bale.productName || "—"}</TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatNumber(parseFloat(bale.weightKg || "0"))}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {bale.status}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              {overLimit && (
                <div className="flex items-center gap-2 text-destructive text-sm">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Selected bales ({formatNumber(selectedKg)} kg) exceed available stock ({formatNumber(availableKg)} kg)
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setAssignDialogOpen(false)} data-testid="button-cancel-assign">
              Cancel
            </Button>
            <Button
              disabled={!sourceBatchId || selectedBaleIds.size === 0 || overLimit || assignMutation.isPending}
              data-testid="button-confirm-assign"
              onClick={() => assignMutation.mutate()}
            >
              {assignMutation.isPending
                ? "Assigning…"
                : `Assign ${selectedBaleIds.size > 0 ? selectedBaleIds.size : ""} Bale${selectedBaleIds.size !== 1 ? "s" : ""}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
