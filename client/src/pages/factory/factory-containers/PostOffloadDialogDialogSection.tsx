// Extracted from ./PostOffloadDialog.tsx to keep that module under the source-size cap.
import { Fragment } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Info,
  Pencil,
  Plus,
  PlusCircle,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MutationResultPanel } from "./postoffloaddialog/components/MutationResultPanel";
import { usePostOffloadDialogState } from "./usePostOffloadDialogState";

export function PostOffloadDialogDialogSection({
  activeCharges,
  chargeHistory,
  container,
  createResult,
  handleClose,
  historyExpanded,
  ledgerAccounts,
  newCharges,
  postOffloadMutation,
  setCreateResult,
  setHistoryExpanded,
  setNewCharges,
  setTxDate,
  setUndoCharge,
  setUndoDate,
  setUndoLegacyRate,
  startEdit,
  txDate,
  undoneCharges,
  wrapAdminAction,
}: Pick<
  ReturnType<typeof usePostOffloadDialogState>,
  | "activeCharges"
  | "chargeHistory"
  | "container"
  | "createResult"
  | "handleClose"
  | "historyExpanded"
  | "ledgerAccounts"
  | "newCharges"
  | "postOffloadMutation"
  | "setCreateResult"
  | "setHistoryExpanded"
  | "setNewCharges"
  | "setTxDate"
  | "setUndoCharge"
  | "setUndoDate"
  | "setUndoLegacyRate"
  | "startEdit"
  | "txDate"
  | "undoneCharges"
  | "wrapAdminAction"
>) {
  return (
    <Dialog
      open={!!container}
      onOpenChange={(v) => {
        if (!v) handleClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PlusCircle className="h-5 w-5 text-blue-500" />
            Post-Offload Charges
          </DialogTitle>
          <DialogDescription>
            Container <strong>{container?.containerNumber}</strong> — charges here update cost per kg and cascade into
            mix batches.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-5 py-2">
          {createResult ? (
            <MutationResultPanel result={createResult} />
          ) : (
            <>
              {/* ── Charge history section ─────────────────────────────── */}
              {chargeHistory.length > 0 && (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={() => setHistoryExpanded((v) => !v)}
                    className="flex items-center gap-1 text-sm font-semibold w-full text-left"
                  >
                    Post-Offload Charge History
                    {historyExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>

                  {historyExpanded && (
                    <div className="border rounded-md divide-y text-sm">
                      {/* Active charges */}
                      {activeCharges.map((charge) => {
                        const isLegacy = charge.supplierLockedRateBefore === null;
                        return (
                          <div key={charge.id} className="px-3 py-2.5 space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex-1 min-w-0">
                                <p className="font-medium truncate">{charge.description}</p>
                                <p className="text-muted-foreground text-xs">
                                  {charge.currencyCode} {parseFloat(charge.amount).toFixed(2)}
                                  {charge.fxRateToUsd && charge.currencyCode !== "USD"
                                    ? ` × ${parseFloat(charge.fxRateToUsd).toFixed(6)} = $${(parseFloat(charge.amount) * parseFloat(charge.fxRateToUsd)).toFixed(4)}`
                                    : ""}
                                  {" · "}
                                  {charge.fxRateConfirmed ? (
                                    <span className="text-green-600 dark:text-green-400">FX ✓</span>
                                  ) : (
                                    <span className="text-amber-600 dark:text-amber-400">FX unconfirmed</span>
                                  )}
                                  {charge.fxRateDate ? ` · ${charge.fxRateDate}` : ""}
                                </p>
                                {charge.supplierInventoryValueDeltaUsd && (
                                  <p className="text-xs text-muted-foreground">
                                    Inventory impact: ${parseFloat(charge.supplierInventoryValueDeltaUsd).toFixed(4)}
                                  </p>
                                )}
                                {isLegacy && (
                                  <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                    <AlertTriangle className="h-3 w-3" /> Legacy — rate input required for edit/undo
                                  </p>
                                )}
                              </div>
                              <div className="flex gap-1 shrink-0">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => startEdit(charge)}
                                  title="Edit charge"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-red-500 hover:text-red-700"
                                  onClick={() => {
                                    setUndoCharge(charge);
                                    setUndoLegacyRate("");
                                    setUndoDate(new Date().toLocaleDateString("en-CA"));
                                  }}
                                  title="Undo charge"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}

                      {/* Undone charges */}
                      {undoneCharges.map((charge) => (
                        <div key={charge.id} className="px-3 py-2 opacity-50">
                          <div className="flex items-center gap-2">
                            <Trash2 className="h-3.5 w-3.5 text-red-500 shrink-0" />
                            <span className="text-muted-foreground text-xs line-through">{charge.description}</span>
                            <span className="text-muted-foreground text-xs ml-auto shrink-0">
                              {charge.currencyCode} {parseFloat(charge.amount).toFixed(2)} · Undone{" "}
                              {charge.deletedAt ? new Date(charge.deletedAt).toLocaleDateString() : ""}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ── Add new charge form ────────────────────────────────── */}
              <div className="space-y-5">
                <div className="flex items-start gap-3 p-3 rounded-md bg-blue-50 dark:bg-blue-950/20 text-blue-800 dark:text-blue-300 text-sm">
                  <Info className="h-4 w-4 mt-0.5 shrink-0" />
                  <p>Enter charges that arrived after the original offload — port fees, duties, handling, etc.</p>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Date</label>
                  <Input
                    type="date"
                    value={txDate}
                    onChange={(e) => setTxDate(e.target.value)}
                    className="w-48"
                    data-testid="input-post-offload-date"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <label className="text-sm font-medium">New Charges</label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setNewCharges((prev) => [
                          ...prev,
                          {
                            id: Date.now().toString(),
                            description: "",
                            amount: "",
                            currencyCode: container?.currencyCode || "USD",
                            ledgerAccountId: "",
                            supplierId: "",
                          },
                        ])
                      }
                      data-testid="button-add-post-offload-charge-row"
                    >
                      <Plus className="h-3 w-3 mr-1" /> Add Row
                    </Button>
                  </div>
                  {newCharges.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center border rounded-md">
                      No charges added yet — click "Add Row" to begin.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      <div className="grid grid-cols-[2fr_1fr_auto_2fr_auto] gap-x-2 gap-y-1 items-center">
                        <div className="text-xs text-muted-foreground font-medium">Description</div>
                        <div className="text-xs text-muted-foreground font-medium">Amount</div>
                        <div className="text-xs text-muted-foreground font-medium">CCY</div>
                        <div className="text-xs text-muted-foreground font-medium">Account / Broker</div>
                        <div />
                        {newCharges.map((charge, idx) => (
                          <Fragment key={charge.id}>
                            <Input
                              value={charge.description}
                              onChange={(e) =>
                                setNewCharges((prev) =>
                                  prev.map((c) => (c.id === charge.id ? { ...c, description: e.target.value } : c))
                                )
                              }
                              placeholder="e.g. Port duty"
                              data-testid={`input-poc-description-${idx}`}
                            />
                            <Input
                              type="number"
                              value={charge.amount}
                              onChange={(e) =>
                                setNewCharges((prev) =>
                                  prev.map((c) => (c.id === charge.id ? { ...c, amount: e.target.value } : c))
                                )
                              }
                              placeholder="0.00"
                              step="0.01"
                              data-testid={`input-poc-amount-${idx}`}
                            />
                            <Select
                              value={charge.currencyCode || "USD"}
                              onValueChange={(v) =>
                                setNewCharges((prev) =>
                                  prev.map((c) => (c.id === charge.id ? { ...c, currencyCode: v } : c))
                                )
                              }
                            >
                              <SelectTrigger className="w-20" data-testid={`select-poc-currency-${idx}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {["USD", "EUR", "GBP", "AUD", "LBP"].map((ccy) => (
                                  <SelectItem key={ccy} value={ccy}>
                                    {ccy}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Select
                              value={charge.ledgerAccountId || ""}
                              onValueChange={(v) =>
                                setNewCharges((prev) =>
                                  prev.map((c) =>
                                    c.id === charge.id ? { ...c, ledgerAccountId: v, supplierId: "" } : c
                                  )
                                )
                              }
                            >
                              <SelectTrigger data-testid={`select-poc-account-${idx}`}>
                                <SelectValue placeholder="Select account (optional)" />
                              </SelectTrigger>
                              <SelectContent>
                                {ledgerAccounts.map((a) => (
                                  <SelectItem key={a.id} value={String(a.id)}>
                                    {a.code ? `${a.code} - ${a.name}` : a.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setNewCharges((prev) => prev.filter((c) => c.id !== charge.id))}
                              data-testid={`button-remove-poc-${idx}`}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="gap-2 pt-2 border-t">
          <Button variant="outline" onClick={handleClose}>
            {createResult ? "Close" : "Cancel"}
          </Button>
          {!createResult && newCharges.some((c) => parseFloat(c.amount || "0") > 0) && (
            <Button
              onClick={() => {
                if (!container) return;
                const valid = newCharges.filter((c) => parseFloat(c.amount || "0") > 0);
                wrapAdminAction(
                  () =>
                    postOffloadMutation.mutate({
                      containerId: container.id,
                      txDate: txDate || new Date().toLocaleDateString("en-CA"),
                      charges: valid.map((c) => ({
                        description: c.description || "Post-offload charge",
                        amount: c.amount,
                        currencyCode: c.currencyCode || "USD",
                        ledgerAccountId: c.ledgerAccountId ? parseInt(c.ledgerAccountId) : null,
                        supplierId: c.supplierId ? parseInt(c.supplierId) : null,
                      })),
                    }),
                  "Add Post-Offload Charges"
                );
              }}
              disabled={postOffloadMutation.isPending}
              data-testid="button-confirm-post-offload-charges"
            >
              {postOffloadMutation.isPending ? "Saving..." : "Save Charges"}
            </Button>
          )}
          {createResult && (
            <Button variant="outline" onClick={() => setCreateResult(null)}>
              Add More
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
