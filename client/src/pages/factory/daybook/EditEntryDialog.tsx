// Extracted from ./FactoryDaybookDialogs.tsx
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FactoryDaybookModel } from "./useFactoryDaybookModel";

export const COST_EDIT_TX_LABELS: Record<string, string> = {
  OFFLOAD_RAW_STOCK: "Total inclusive cost (base material)",
  FREIGHT: "Freight charge",
  COMMISSION: "Commission",
  DUTY: "Duty",
  OTHER_CHARGE: "Other charge / additional charge",
};

export function EditEntryDialog({ model }: { model: FactoryDaybookModel }) {
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
                    {model.editMutation.isPending ? "Updating…" : "Update"}
                  </Button>
                </div>
              </div>
            );
          })()}
      </DialogContent>
    </Dialog>
  );
}
