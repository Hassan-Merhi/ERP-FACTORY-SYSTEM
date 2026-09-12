/**
 * Dialogs of the ERP container loading scan page: the Validate & Finalize
 * review and the resume "last scanned" prompt.
 *
 * With a reusable linked proforma the review is informational: items listed on
 * the proforma are shown as on-proforma, and other loaded items are explicitly
 * allowed rather than rendered as destructive errors.
 */
import { AlertTriangle, CheckCircle, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ContainerLoadingScanModel } from "./useContainerLoadingScanModel";

function ReviewTable({ model }: { model: ContainerLoadingScanModel }) {
  const { proformaProgress, extraArticles, loadedByArticle } = model;
  return (
    <div className="overflow-y-auto max-h-[340px] border rounded-md">
      <Table>
        <TableHeader className="sticky top-0 z-30 bg-background">
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

function ReviewTotals({ model }: { model: ContainerLoadingScanModel }) {
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

function FinalizeDialog({ model }: { model: ContainerLoadingScanModel }) {
  const { linkedProforma, proformaProgress, bales, totalWeight, finalizeMutation } = model;
  const hasProformaReview = !!linkedProforma && proformaProgress.length > 0;
  const referenceOnly = proformaProgress.some((line) => line.status === "reference");
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
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => model.setShowFinalizeDialog(false)}
              data-testid="button-cancel-finalize"
            >
              Cancel
            </Button>
            <Button
              onClick={() => finalizeMutation.mutate()}
              disabled={finalizeMutation.isPending}
              data-testid="button-confirm-finalize"
            >
              <CheckCircle className="mr-2 h-4 w-4" />
              {finalizeMutation.isPending ? "Finalizing..." : "Confirm Finalize"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LastScannedPrompt({ model }: { model: ContainerLoadingScanModel }) {
  const { lastScannedRef } = model;
  return (
    <Dialog open={model.showLastScannedPopup} onOpenChange={model.setShowLastScannedPopup}>
      <DialogContent className="max-w-sm" data-testid="dialog-last-scanned">
        <DialogHeader>
          <DialogTitle className="text-base">Resuming Loading</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Last bale scanned in this session:</p>
          <div
            className="bg-muted rounded-md px-4 py-3 font-mono text-lg font-semibold text-center"
            data-testid="text-last-scanned-ref"
          >
            {lastScannedRef?.baleReference}
            {lastScannedRef?.baleName && (
              <div className="text-sm font-normal text-muted-foreground mt-1">{lastScannedRef.baleName}</div>
            )}
          </div>
          <Button
            className="w-full"
            onClick={() => model.setShowLastScannedPopup(false)}
            data-testid="button-dismiss-last-scanned"
          >
            Continue Scanning
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function LoadingScanDialogs({ model }: { model: ContainerLoadingScanModel }) {
  return (
    <>
      {/* Validate & Finalize Dialog */}
      <FinalizeDialog model={model} />
      <LastScannedPrompt model={model} />
    </>
  );
}
