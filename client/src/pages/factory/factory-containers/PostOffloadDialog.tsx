import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import { Pencil, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/formatNumber";

import type { PostOffloadDialogProps } from "./postoffloaddialog/types";
import { RateCell } from "./postoffloaddialog/components/RateCell";
import { MutationResultPanel } from "./postoffloaddialog/components/MutationResultPanel";
import { usePostOffloadDialogState } from "./usePostOffloadDialogState";
import { PostOffloadDialogDialogSection } from "./PostOffloadDialogDialogSection";

// ─── Types ────────────────────────────────────────────────────────────────────

export function PostOffloadDialog(props: PostOffloadDialogProps) {
  const {
    AdminDialog,
    activeCharges,
    chargeHistory,
    container,
    createResult,
    editAmount,
    editCcy,
    editDesc,
    editLedgerId,
    editLegacyRate,
    editMutation,
    editResult,
    editTxDate,
    editingCharge,
    handleClose,
    handleConfirmUndo,
    handleLegacyRebuild,
    handleSaveEdit,
    historyExpanded,
    ledgerAccounts,
    newCharges,
    postOffloadMutation,
    rebuildMutation,
    setCreateResult,
    setEditAmount,
    setEditCcy,
    setEditDesc,
    setEditLedgerId,
    setEditLegacyRate,
    setEditResult,
    setEditTxDate,
    setEditingCharge,
    setHistoryExpanded,
    setNewCharges,
    setTxDate,
    setUndoCharge,
    setUndoDate,
    setUndoLegacyRate,
    setUndoResult,
    startEdit,
    txDate,
    undoCharge,
    undoDate,
    undoLegacyRate,
    undoMutation,
    undoResult,
    undoneCharges,
    wrapAdminAction,
  } = usePostOffloadDialogState(props);

  // ─── Undo confirmation panel ──────────────────────────────────────────────
  if (undoCharge && !undoResult) {
    const isLegacy = undoCharge.supplierLockedRateBefore === null;
    return (
      <>
        <Dialog
          open={!!container}
          onOpenChange={(v) => {
            if (!v) handleClose();
          }}
        >
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
                <AlertTriangle className="h-5 w-5" /> Undo Post-Offload Charge
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2 text-sm">
              <p>This will reverse the following charge and all its downstream effects:</p>
              <div className="rounded-md border px-3 py-2 space-y-1">
                <p>
                  <strong>{undoCharge.description}</strong>
                </p>
                <p className="text-muted-foreground">
                  {undoCharge.currencyCode} {parseFloat(undoCharge.amount).toFixed(2)}
                  {undoCharge.fxRateToUsd && undoCharge.currencyCode !== "USD"
                    ? ` × ${parseFloat(undoCharge.fxRateToUsd).toFixed(6)}`
                    : ""}
                </p>
              </div>
              <ul className="text-sm text-muted-foreground list-disc pl-4 space-y-0.5">
                <li>Container landed cost reverted</li>
                <li>Raw-stock cost per kg reverted</li>
                <li>Supplier locked rate reverted</li>
                <li>All linked mix-batch and bale costs reverted</li>
                <li>Linked voucher soft-deleted</li>
                <li>Reversing daybook entry created</li>
              </ul>
              {isLegacy && (
                <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                  <p className="text-amber-800 dark:text-amber-300 font-medium flex items-center gap-1.5">
                    <AlertTriangle className="h-4 w-4" /> Legacy charge — original supplier rate required
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Enter the supplier locked rate that was in effect immediately before this charge was applied.
                  </p>
                  <Input
                    type="number"
                    step="0.000001"
                    value={undoLegacyRate}
                    onChange={(e) => setUndoLegacyRate(e.target.value)}
                    placeholder="e.g. 0.607861"
                  />
                </div>
              )}
              <div className="space-y-1">
                <label className="text-sm font-medium">Reversal date</label>
                <Input type="date" value={undoDate} onChange={(e) => setUndoDate(e.target.value)} className="w-48" />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setUndoCharge(null);
                  setUndoLegacyRate("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleConfirmUndo}
                disabled={undoMutation.isPending || (isLegacy && !undoLegacyRate)}
              >
                {undoMutation.isPending ? "Undoing..." : "Confirm Undo"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {AdminDialog}
      </>
    );
  }

  // ─── Show undo result ────────────────────────────────────────────────────
  if (undoResult) {
    return (
      <>
        <Dialog
          open={!!container}
          onOpenChange={(v) => {
            if (!v) handleClose();
          }}
        >
          <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Charge Undone</DialogTitle>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto py-2">
              <MutationResultPanel result={undoResult} />
            </div>
            <DialogFooter className="pt-2 border-t">
              <Button
                variant="outline"
                onClick={() => {
                  setUndoResult(null);
                }}
              >
                Back
              </Button>
              <Button onClick={handleClose}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {AdminDialog}
      </>
    );
  }

  // ─── Edit panel ───────────────────────────────────────────────────────────
  if (editingCharge) {
    const isLegacy = editingCharge.supplierLockedRateBefore === null;
    const isBusy = editMutation.isPending || rebuildMutation.isPending;

    return (
      <>
        <Dialog
          open={!!container}
          onOpenChange={(v) => {
            if (!v) handleClose();
          }}
        >
          <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Pencil className="h-5 w-5 text-blue-500" /> Edit Post-Offload Charge
              </DialogTitle>
              <DialogDescription>
                Container <strong>{container?.containerNumber}</strong> — editing charge #{editingCharge.id}
              </DialogDescription>
            </DialogHeader>

            <div className="flex-1 overflow-y-auto space-y-4 py-2">
              {editResult ? (
                <MutationResultPanel result={editResult} />
              ) : (
                <>
                  {isLegacy && (
                    <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                      <p className="text-amber-800 dark:text-amber-300 font-medium flex items-center gap-1.5 text-sm">
                        <AlertTriangle className="h-4 w-4" /> Legacy charge — original supplier rate required
                      </p>
                      <p className="text-xs text-muted-foreground">
                        This charge was created before supplier-rate snapshots were stored. Enter the supplier locked
                        rate that was in effect immediately before this charge. For CYPRUS MODA, enter 0.607861.
                      </p>
                      <Input
                        type="number"
                        step="0.000001"
                        value={editLegacyRate}
                        onChange={(e) => setEditLegacyRate(e.target.value)}
                        placeholder="e.g. 0.607861"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2 space-y-1">
                      <label className="text-sm font-medium">Description</label>
                      <Input
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        placeholder="e.g. Port duty"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium">Amount</label>
                      <Input
                        type="number"
                        value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)}
                        step="0.01"
                        placeholder="0.00"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-sm font-medium">Currency</label>
                      <Select value={editCcy} onValueChange={setEditCcy}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["USD", "EUR", "GBP", "AUD", "LBP"].map((c) => (
                            <SelectItem key={c} value={c}>
                              {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-2 space-y-1">
                      <label className="text-sm font-medium">Account (optional)</label>
                      <UnifiedAccountPicker
                    options={[{ value: "__none__", name: "None" }, ...ledgerAccounts.filter((a) => a.isPostingLeaf !== false).map((a) => ({ value: String(a.id), name: String(a.name ?? "") }))]}
                    value={editLedgerId || "__none__"}
                    selectedFallbackName={ledgerAccounts.find((a) => String(a.id) === editLedgerId)?.name?.toString()}
                    onChange={(v) => setEditLedgerId(v === "__none__" ? "" : v)}
                    placeholder={"Select account (optional)"}
                    />
                    </div>
                    <div className="col-span-2 space-y-1">
                      <label className="text-sm font-medium">Date</label>
                      <Input
                        type="date"
                        value={editTxDate}
                        onChange={(e) => setEditTxDate(e.target.value)}
                        className="w-48"
                      />
                    </div>
                  </div>

                  {/* Snapshot info */}
                  {(editingCharge.supplierLockedRateBefore || editingCharge.supplierInventoryValueDeltaUsd) && (
                    <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground space-y-1">
                      <p className="font-medium text-foreground text-sm">Stored snapshots</p>
                      <RateCell label="Rate before" value={editingCharge.supplierLockedRateBefore} />
                      <RateCell label="Rate after" value={editingCharge.supplierLockedRateAfter} />
                      {editingCharge.supplierRemainingKgAtApply && (
                        <div className="flex justify-between">
                          <span>Supplier remaining at apply</span>
                          <span className="font-mono">
                            {formatNumber(parseFloat(editingCharge.supplierRemainingKgAtApply))} kg
                          </span>
                        </div>
                      )}
                      {editingCharge.supplierInventoryValueDeltaUsd && (
                        <div className="flex justify-between">
                          <span>Inventory value applied</span>
                          <span className="font-mono">
                            ${parseFloat(editingCharge.supplierInventoryValueDeltaUsd).toFixed(6)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <DialogFooter className="gap-2 pt-2 border-t flex-wrap">
              <Button
                variant="outline"
                onClick={() => {
                  setEditingCharge(null);
                  setEditResult(null);
                }}
              >
                {editResult ? "Back" : "Cancel"}
              </Button>
              {!editResult && (
                <>
                  {isLegacy && editLegacyRate && (
                    <Button
                      variant="outline"
                      onClick={handleLegacyRebuild}
                      disabled={isBusy}
                      title="Fix supplier rate using the legacy baseline without changing the charge amount or accounting"
                    >
                      {rebuildMutation.isPending ? "Rebuilding..." : "Rebuild Rate Only"}
                    </Button>
                  )}
                  <Button onClick={handleSaveEdit} disabled={isBusy || !editAmount || parseFloat(editAmount) <= 0}>
                    {editMutation.isPending ? "Saving..." : "Save Edit"}
                  </Button>
                </>
              )}
              {editResult && <Button onClick={handleClose}>Close</Button>}
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {AdminDialog}
      </>
    );
  }

  // ─── Main dialog ──────────────────────────────────────────────────────────
  return (
    <>
      <PostOffloadDialogDialogSection
        activeCharges={activeCharges}
        chargeHistory={chargeHistory}
        container={container}
        createResult={createResult}
        handleClose={handleClose}
        historyExpanded={historyExpanded}
        ledgerAccounts={ledgerAccounts}
        newCharges={newCharges}
        postOffloadMutation={postOffloadMutation}
        setCreateResult={setCreateResult}
        setHistoryExpanded={setHistoryExpanded}
        setNewCharges={setNewCharges}
        setTxDate={setTxDate}
        setUndoCharge={setUndoCharge}
        setUndoDate={setUndoDate}
        setUndoLegacyRate={setUndoLegacyRate}
        startEdit={startEdit}
        txDate={txDate}
        undoneCharges={undoneCharges}
        wrapAdminAction={wrapAdminAction}
      />
      {AdminDialog}
    </>
  );
}
