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
import type { FactoryDaybookModel } from "./useFactoryDaybookModel";

const COST_EDIT_TX_LABELS: Record<string, string> = {
  OFFLOAD_RAW_STOCK: "Total inclusive cost (base material)",
  FREIGHT: "Freight charge",
  COMMISSION: "Commission",
  DUTY: "Duty",
  OTHER_CHARGE: "Other charge / additional charge",
};

function EditEntryDialog({ model }: { model: FactoryDaybookModel }) {
  const { editEntry } = model;
  return (
    <Dialog
      open={editEntry !== null}
      onOpenChange={(open) => {
        if (!open) model.setEditEntry(null);
      }}
    >
      <DialogContent data-testid="dialog-edit-daybook">
        <DialogHeader>
          <DialogTitle>Edit Daybook Entry</DialogTitle>
          <DialogDescription>Modify the entry details. A reason is required for the audit trail.</DialogDescription>
        </DialogHeader>
        {editEntry &&
          (() => {
            const isVoucherBacked = editEntry.referenceTable === "vouchers" || editEntry.id < 0;
            return (
              <div className="space-y-4">
                {isVoucherBacked && (
                  <div
                    className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                    data-testid="note-voucher-sync"
                  >
                    Saving will update the description on the linked voucher, so Accounts statements stay in sync. To
                    change amounts, use the source record edit button.
                  </div>
                )}
                <div>
                  <Label className="text-sm font-medium">Description</Label>
                  <Textarea
                    value={model.editDescription}
                    onChange={(e) => model.setEditDescription(e.target.value)}
                    data-testid="input-edit-description"
                  />
                </div>
                <div>
                  <Label className="text-sm font-medium">Date</Label>
                  <Input
                    type="date"
                    value={model.editTxDate}
                    onChange={(e) => model.setEditTxDate(e.target.value)}
                    data-testid="input-edit-tx-date"
                  />
                </div>
                {!isVoucherBacked && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-sm font-medium">Amount ({editEntry.currencyCode})</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={model.editAmountCurrency}
                        onChange={(e) => model.setEditAmountCurrency(e.target.value)}
                        data-testid="input-edit-amount-currency"
                      />
                    </div>
                    <div>
                      <Label className="text-sm font-medium">Amount (USD)</Label>
                      <Input
                        type="number"
                        step="0.01"
                        value={model.editAmountUsd}
                        onChange={(e) => model.setEditAmountUsd(e.target.value)}
                        data-testid="input-edit-amount-usd"
                      />
                    </div>
                  </div>
                )}
                <div>
                  <Label className="text-sm font-medium">Reason for edit *</Label>
                  <Textarea
                    value={model.editReason}
                    onChange={(e) => model.setEditReason(e.target.value)}
                    placeholder="Why is this change needed?"
                    data-testid="input-edit-reason"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => model.setEditEntry(null)} data-testid="button-cancel-edit">
                    Cancel
                  </Button>
                  <Button
                    disabled={!model.editReason.trim() || model.editMutation.isPending}
                    onClick={() => model.wrapAdminAction(model.handleEditSubmit, "Edit Entry")}
                    data-testid="button-submit-edit"
                  >
                    {model.editMutation.isPending ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </div>
            );
          })()}
      </DialogContent>
    </Dialog>
  );
}

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
            <ViewEntryModal
              entry={viewEntry}
              onClose={() => model.setViewEntry(null)}
              onNavigate={model.navigate}
              formatDisplayDate={model.formatDisplayDate}
            />
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
              This will reverse all accounting entries. This action cannot be undone.
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
              {model.voidMutation.isPending ? "Voiding..." : "Void Voucher"}
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
            <AlertDialogTitle>Permanently delete this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the daybook entry. This action cannot be undone.
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
              {model.deleteMutation.isPending ? "Deleting..." : "Delete Entry"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CostEditDialog model={model} />
    </>
  );
}
