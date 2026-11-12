/**
 * ReconcileBalancesDialog — extracted from AdvancesView.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useAdvancesModel } from "../advances/useAdvancesModel";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

type AdvancesModel = ReturnType<typeof useAdvancesModel>;
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { fmt } from "../utils";

export function ReconcileBalancesDialog({
  formatDate,
  reconcileMutation,
  reconcileOpen,
  reconcilePreview,
  reconcilePreviewLoading,
  setReconcileOpen,
}: {
  formatDate: AdvancesModel["formatDate"];
  reconcileMutation: AdvancesModel["reconcileMutation"];
  reconcileOpen: AdvancesModel["reconcileOpen"];
  reconcilePreview: AdvancesModel["reconcilePreview"];
  reconcilePreviewLoading: AdvancesModel["reconcilePreviewLoading"];
  setReconcileOpen: AdvancesModel["setReconcileOpen"];
}) {
  const recordChanges = useExistingRecordChangeAccess();
  return (
    <Dialog open={reconcileOpen} onOpenChange={setReconcileOpen}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reconcile Advance Balances — Preview</DialogTitle>
          <DialogDescription>
            Replays all payroll deductions and manual repayments in order to recalculate every Salary Deduction advance
            balance from scratch. Review the changes below before confirming.
          </DialogDescription>
        </DialogHeader>

        {reconcilePreviewLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Calculating preview…
          </div>
        ) : !reconcilePreview ? null : (
          (() => {
            const dirty = reconcilePreview.changes.filter((c) => c.changed);
            const clean = reconcilePreview.changes.filter((c) => !c.changed);
            return (
              <div className="space-y-4">
                {/* Summary */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  <div className="rounded-md bg-muted/40 px-3 py-2 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Total Advances</p>
                    <p className="font-bold">{reconcilePreview.totalAdvances}</p>
                  </div>
                  <div className="rounded-md bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Will Change</p>
                    <p className="font-bold text-amber-700 dark:text-amber-400">{dirty.length}</p>
                  </div>
                  <div className="rounded-md bg-green-50 dark:bg-green-900/20 px-3 py-2 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Already Correct</p>
                    <p className="font-bold text-green-700 dark:text-green-400">{clean.length}</p>
                  </div>
                </div>

                {dirty.length === 0 ? (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    All balances are already correct — nothing will change.
                  </div>
                ) : (
                  <div className="border rounded-md overflow-hidden">
                    <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 px-4 py-2 text-xs font-medium text-muted-foreground bg-muted/20">
                      <span>Worker</span>
                      <span className="text-right">Date</span>
                      <span className="text-right">Original</span>
                      <span className="text-right">Current Balance</span>
                      <span className="text-right">New Balance</span>
                    </div>
                    <div className="divide-y">
                      {dirty.map((c) => (
                        <div
                          key={c.advanceId}
                          className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 px-4 py-2 text-sm items-center"
                          data-testid={`row-reconcile-preview-${c.advanceId}`}
                        >
                          <span className="font-medium">{c.workerName}</span>
                          <span className="text-muted-foreground text-right font-mono text-xs">
                            {c.advanceDate ? formatDate(c.advanceDate) : "—"}
                          </span>
                          <span className="font-mono text-right text-muted-foreground">{fmt(c.originalAmount)}</span>
                          <span className="font-mono text-right text-amber-700 dark:text-amber-400">
                            {fmt(c.currentBalance)}
                          </span>
                          <span
                            className={`font-mono text-right font-semibold ${parseFloat(c.newBalance) === 0 ? "text-green-700 dark:text-green-400" : "text-foreground"}`}
                          >
                            {fmt(c.newBalance)}
                            {c.newFullyPaid && !c.currentFullyPaid && (
                              <span className="ml-1 text-xs text-green-600 dark:text-green-400">(paid)</span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setReconcileOpen(false)} data-testid="button-cancel-reconcile">
            Cancel
          </Button>
          {recordChanges.allowed && (
            <Button
              onClick={() => reconcileMutation.mutate()}
              disabled={
                reconcileMutation.isPending ||
                reconcilePreviewLoading ||
                reconcilePreview?.changes.filter((c) => c.changed).length === 0
              }
              data-testid="button-confirm-reconcile"
            >
              {reconcileMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Reconciling…
                </>
              ) : reconcilePreview?.changes.filter((c) => c.changed).length === 0 ? (
                "Nothing to Change"
              ) : (
                `Confirm — Update ${reconcilePreview?.changes.filter((c) => c.changed).length ?? "…"} Record(s)`
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
