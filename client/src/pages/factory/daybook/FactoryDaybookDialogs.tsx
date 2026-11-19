/**
 * Every modal the Factory Daybook transactions tab owns: edit entry, view
 * details, void voucher, hard delete and the cascading container cost edit.
 *
 * Behaviour is unchanged from the inline markup — in particular the
 * voucher-backed edit still hides the amount fields and syncs the description
 * to the linked voucher, and both destructive flows still go through the admin
 * override wrapper where they did before.
 */
import { AlertTriangle, Pencil } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatNumber } from "@/lib/formatNumber";
import { formatDaybookDescription } from "./daybookUtils";
import { ViewEntryModal } from "./ViewEntryModal";
import { FactoryDaybookCostCenters } from "./FactoryDaybookCostCenters";
import type { FactoryDaybookModel } from "./useFactoryDaybookModel";
import { COST_EDIT_TX_LABELS, EditEntryDialog } from "./EditEntryDialog";

function CostEditDialog({ model }: { model: FactoryDaybookModel }) {
  const { costEditEntry } = model;
  return (
    <Dialog
      open={costEditEntry !== null}
      onOpenChange={(open) => {
        if (!open) model.setCostEditEntry(null);
      }}
    >
      <DialogContent className="max-w-md" data-testid="dialog-cost-edit-daybook">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4 text-amber-500" />
            Edit Container Cost
          </DialogTitle>
          <DialogDescription>
            {costEditEntry &&
              `${COST_EDIT_TX_LABELS[costEditEntry.txType] || costEditEntry.txType} — ${costEditEntry.description}`}
          </DialogDescription>
        </DialogHeader>
        {costEditEntry &&
          (() => {
            const isDuty = costEditEntry.txType === "DUTY";
            const isBaseMaterial = costEditEntry.txType === "OFFLOAD_RAW_STOCK";
            return (
              <div className="space-y-4 py-1">
                <div className="rounded-md border bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 p-3 text-sm space-y-1">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <div className="space-y-1">
                      <p className="font-medium">This will cascade to inventory costs.</p>
                      <p>
                        Saving updates the raw stock cost per kg and recalculates the weighted-average cost of all mix
                        batches that used this container.
                      </p>
                      {isBaseMaterial && <p>Editing the total cost will back-calculate a new base rate per kg.</p>}
                      {isDuty && <p>Only confirmed duty can be edited here. A duty audit log entry will be written.</p>}
                    </div>
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium">Current amount ({costEditEntry.currencyCode})</Label>
                  <div className="text-sm text-muted-foreground font-mono mt-0.5">
                    {formatNumber(parseFloat(costEditEntry.amountCurrency || "0"), 2)} {costEditEntry.currencyCode}
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium">New amount ({costEditEntry.currencyCode}) *</Label>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={model.costEditAmount}
                    onChange={(e) => model.setCostEditAmount(e.target.value)}
                    placeholder="Enter corrected amount"
                    data-testid="input-cost-edit-amount"
                  />
                </div>
                <div>
                  <Label className="text-sm font-medium">Reason for edit *</Label>
                  <Textarea
                    value={model.costEditReason}
                    onChange={(e) => model.setCostEditReason(e.target.value)}
                    placeholder="Why is this correction needed?"
                    data-testid="input-cost-edit-reason"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => model.setCostEditEntry(null)}
                    data-testid="button-cancel-cost-edit"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={!model.costEditReason.trim() || !model.costEditAmount || model.costEditMutation.isPending}
                    onClick={() => {
                      if (!costEditEntry) return;
                      model.costEditMutation.mutate({
                        entryId: costEditEntry.id,
                        newAmount: model.costEditAmount,
                        reason: model.costEditReason.trim(),
                      });
                    }}
                    data-testid="button-submit-cost-edit"
                  >
                    {model.costEditMutation.isPending ? "Saving..." : "Save & Recalculate"}
                  </Button>
                </div>
              </div>
            );
          })()}
      </DialogContent>
    </Dialog>
  );
}

export function FactoryDaybookDialogs({ model }: { model: FactoryDaybookModel }) {
  const { viewEntry, voidEntry, deleteEntry } = model;
  return (
    <>
      <EditEntryDialog model={model} />

      {/* View Details Modal */}
      <Dialog
        open={viewEntry !== null}
        onOpenChange={(open) => {
          if (!open) model.setViewEntry(null);
        }}
      >
        <DialogContent
          className="w-full max-w-[95vw] md:max-w-4xl max-h-[90dvh] overflow-y-auto"
          data-testid="dialog-view-entry"
        >
          {viewEntry && (
            <div className="space-y-4">
              <ViewEntryModal
                entry={viewEntry}
                onClose={() => model.setViewEntry(null)}
                onNavigate={model.navigate}
                formatDisplayDate={model.formatDisplayDate}
              />
              <FactoryDaybookCostCenters entry={viewEntry} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Void Alert */}
      <AlertDialog
        open={voidEntry !== null}
        onOpenChange={(open) => {
          if (!open) model.setVoidEntry(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-void-voucher">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this voucher?</AlertDialogTitle>
            <AlertDialogDescription>
              {voidEntry?.description?.startsWith("FX agent payment:") ||
              voidEntry?.description === "FX agent EUR settlement to USD beneficiary"
                ? "The USD payment and FX gain/loss will be removed from posted balances, and the exact EUR amount returned to the agent. The cancelled payment remains in the audit trail."
                : "This will reverse all accounting entries. This action cannot be undone."}
              {voidEntry && <span className="block mt-2 font-medium text-foreground">{voidEntry.description}</span>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-void">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                model.wrapAdminAction(() => voidEntry && model.voidMutation.mutate(voidEntry.id), "Void Entry")
              }
              disabled={model.voidMutation.isPending}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-void"
            >
              {model.voidMutation.isPending ? "Deleting..." : "Delete Voucher"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* Hard Delete Alert */}
      <AlertDialog
        open={deleteEntry !== null}
        onOpenChange={(open) => {
          if (!open) model.setDeleteEntry(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-delete-entry">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteEntry?.txType.startsWith("PRODUCTION_TARGET_")
                ? "Remove bonus payment and reverse accounting?"
                : "Permanently delete this entry?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteEntry?.txType.startsWith("PRODUCTION_TARGET_")
                ? "This removes the posted bonus from the active Daybook and posts a reversing Receipt to restore Cash / Bank and Payroll Deposit Expense. The original voucher and reversal are retained for audit. The same worker bonus cannot be paid twice."
                : "This will permanently remove the daybook entry. This action cannot be undone."}
              {deleteEntry && (
                <span className="block mt-2 font-medium text-foreground">{formatDaybookDescription(deleteEntry)}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteEntry && model.deleteMutation.mutate(deleteEntry.id)}
              disabled={model.deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              {model.deleteMutation.isPending
                ? "Processing..."
                : deleteEntry?.txType.startsWith("PRODUCTION_TARGET_")
                  ? "Reverse & Remove"
                  : "Delete Entry"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CostEditDialog model={model} />
    </>
  );
}
