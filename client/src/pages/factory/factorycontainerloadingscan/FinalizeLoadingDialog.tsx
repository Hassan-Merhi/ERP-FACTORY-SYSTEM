/**
 * Validate & Finalize dialog for the container loading scan page. During a live
 * loading the proforma is a reusable reference, so the review is informational
 * and does not create an artificial "remaining proforma" carryover.
 */
import { AlertTriangle, CheckCircle, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FactoryContainerLoadingScanModel } from "./useFactoryContainerLoadingScanModel";

function ReviewTable({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { proformaProgress, extraArticles, groupedBalesMap, loadedByArticle } = model;
  return (
    <div className="overflow-y-auto max-h-[340px] border rounded-md">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Article / Product</TableHead>
            <TableHead className="text-right">Proforma</TableHead>
            <TableHead className="text-right">Loaded Here</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {proformaProgress.map((line) => (
            <TableRow
              key={line.id}
              className={
                line.status === "reference"
                  ? ""
                  : line.status === "fulfilled"
                    ? "bg-green-50 dark:bg-green-950/40"
                    : line.status === "overloaded"
                      ? "bg-orange-50 dark:bg-orange-950/30"
                      : ""
              }
            >
              <TableCell className="text-sm">
                <div className="font-mono text-xs">{line.articleCode}</div>
                <div className="text-muted-foreground text-xs">{line.productName}</div>
              </TableCell>
              <TableCell className="text-right font-mono text-sm">{line.quantity}</TableCell>
              <TableCell className="text-right font-mono text-sm">{line.totalLoaded}</TableCell>
              <TableCell className="text-right text-sm">
                {line.status === "reference" && (
                  <span className="text-muted-foreground font-medium flex items-center justify-end gap-1">
                    <Info className="h-3 w-3" />
                    On Proforma
                  </span>
                )}
                {line.status === "fulfilled" && (
                  <span className="text-green-600 dark:text-green-400 font-semibold">✓ Done</span>
                )}
                {line.status === "overloaded" && (
                  <span className="text-orange-600 dark:text-orange-400 font-semibold flex items-center justify-end gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Over +{line.excess}
                  </span>
                )}
                {(line.status === "short" || line.status === "none") && (
                  <span className="text-amber-600 dark:text-amber-400 flex items-center justify-end gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Short {line.remaining}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
          {extraArticles.map((code) => (
            <TableRow key={code} className="bg-muted/20">
              <TableCell className="text-sm">
                <div className="font-mono text-xs">{code}</div>
                {groupedBalesMap[code]?.baleName && (
                  <div className="text-muted-foreground text-xs font-sans font-normal">
                    {groupedBalesMap[code].baleName}
                  </div>
                )}
                <div className="text-muted-foreground text-xs">Not on Proforma — Allowed</div>
              </TableCell>
              <TableCell className="text-right font-mono text-sm text-muted-foreground">—</TableCell>
              <TableCell className="text-right font-mono text-sm font-semibold">{loadedByArticle[code]}</TableCell>
              <TableCell className="text-right text-sm">
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  Not on Proforma — Allowed
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ReviewTotals({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { proformaProgress, extraArticles, bales, totalWeight } = model;
  const referenceOnly = proformaProgress.some((line) => line.status === "reference");
  const fulfilled = proformaProgress.filter((l) => l.status === "fulfilled").length;
  const overloaded = proformaProgress.filter((l) => l.status === "overloaded").length;
  const short = proformaProgress.filter((l) => l.status === "short" || l.status === "none").length;
  return (
    <div className="flex items-center justify-between gap-2 text-sm border-t pt-2 flex-wrap gap-y-1">
      <div className="flex items-center gap-3 flex-wrap">
        {referenceOnly ? (
          <span className="text-muted-foreground font-medium">Reusable proforma — quantities are informational</span>
        ) : (
          <>
            <span className="text-green-600 dark:text-green-400 font-medium">{fulfilled} fulfilled</span>
            {overloaded > 0 && (
              <span className="text-orange-600 dark:text-orange-400 font-medium">{overloaded} overloaded</span>
            )}
            {short > 0 && <span className="text-amber-600 dark:text-amber-400 font-medium">{short} short</span>}
          </>
        )}
        {extraArticles.length > 0 && (
          <span className="text-muted-foreground font-medium">{extraArticles.length} not on proforma — allowed</span>
        )}
      </div>
      <span className="text-muted-foreground">
        {bales.length} bales · {totalWeight.toFixed(1)} kg
      </span>
    </div>
  );
}

export function FinalizeLoadingDialog({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { linkedProforma, proformaProgress, bales, totalWeight, finalizeMutation, remainingProformaBales } = model;
  const hasProformaReview = !!linkedProforma && proformaProgress.length > 0;
  const referenceOnly = proformaProgress.some((line) => line.status === "reference");
  const hasRemaining = !referenceOnly && !!linkedProforma && remainingProformaBales > 0;
  return (
    <Dialog open={model.showFinalizeDialog} onOpenChange={model.setShowFinalizeDialog}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Validate Loading</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {hasProformaReview ? (
            <>
              <p className="text-sm text-muted-foreground">
                {referenceOnly
                  ? "Review this loading beside the reusable proforma. Quantities are not capped across loadings."
                  : "Review what was loaded vs the proforma before finalizing."}
              </p>
              <ReviewTable model={model} />
              <ReviewTotals model={model} />
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                This will mark the loading as complete and send it for office verification.
              </p>
              <div className="space-y-1 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>Total Bales:</span>
                  <span className="font-mono font-semibold" data-testid="text-dialog-total-bales">
                    {bales.length}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Total Weight:</span>
                  <span className="font-mono font-semibold" data-testid="text-dialog-total-weight">
                    {totalWeight.toFixed(2)} kg
                  </span>
                </div>
              </div>
            </>
          )}
          <div className="space-y-1">
            <label className="text-sm font-medium">Loading Date</label>
            <input
              type="date"
              value={model.finalizeDate}
              onChange={(e) => model.setFinalizeDate(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="input-finalize-date"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => model.setShowFinalizeDialog(false)}
              data-testid="button-cancel-finalize"
            >
              Cancel
            </Button>
            {hasRemaining ? (
              <>
                <Button
                  variant="outline"
                  onClick={() =>
                    finalizeMutation.mutate({ txDate: model.finalizeDate, createCarryoverProforma: false })
                  }
                  disabled={finalizeMutation.isPending}
                  data-testid="button-finalize-only"
                >
                  NVM — Finalize Only
                </Button>
                <Button
                  onClick={() => finalizeMutation.mutate({ txDate: model.finalizeDate, createCarryoverProforma: true })}
                  disabled={finalizeMutation.isPending}
                  data-testid="button-create-carryover-proforma"
                >
                  <CheckCircle className="mr-2 h-4 w-4" />
                  {finalizeMutation.isPending ? "Creating..." : `Move ${remainingProformaBales} Remaining`}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => finalizeMutation.mutate({ txDate: model.finalizeDate })}
                disabled={finalizeMutation.isPending}
                data-testid="button-confirm-finalize"
              >
                <CheckCircle className="mr-2 h-4 w-4" />
                {finalizeMutation.isPending ? "Finalizing..." : "Confirm Finalize"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
