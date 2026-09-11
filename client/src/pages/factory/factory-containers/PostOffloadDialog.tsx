import { useState, Fragment } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  PlusCircle,
  Plus,
  X,
  Info,
  Pencil,
  Trash2,
  AlertTriangle,
  RotateCcw,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { formatNumber } from "@/lib/formatNumber";
import { useAdminOverride } from "@/hooks/use-admin-override";

import type { HistoryRow, MutationResult, PostOffloadCharge, PostOffloadDialogProps } from "./postoffloaddialog/types";
import { invalidateChargeQueries } from "./postoffloaddialog/utils";
import { RateCell } from "./postoffloaddialog/components/RateCell";
import { MutationResultPanel } from "./postoffloaddialog/components/MutationResultPanel";
// ─── Types ────────────────────────────────────────────────────────────────────

export function PostOffloadDialog({ container, ledgerAccounts, onClose }: PostOffloadDialogProps) {
  const { toast } = useToast();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();

  // New-charge form state
  const [newCharges, setNewCharges] = useState<PostOffloadCharge[]>([]);
  const [txDate, setTxDate] = useState<string>(() => new Date().toLocaleDateString("en-CA"));
  const [createResult, setCreateResult] = useState<MutationResult | null>(null);

  // Edit mode state
  const [editingCharge, setEditingCharge] = useState<HistoryRow | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editCcy, setEditCcy] = useState("USD");
  const [editLedgerId, setEditLedgerId] = useState("");
  const [editTxDate, setEditTxDate] = useState<string>(() => new Date().toLocaleDateString("en-CA"));
  const [editResult, setEditResult] = useState<MutationResult | null>(null);
  const [editLegacyRate, setEditLegacyRate] = useState("");

  // Undo state
  const [undoCharge, setUndoCharge] = useState<HistoryRow | null>(null);
  const [undoLegacyRate, setUndoLegacyRate] = useState("");
  const [undoResult, setUndoResult] = useState<MutationResult | null>(null);
  const [undoDate, setUndoDate] = useState<string>(() => new Date().toLocaleDateString("en-CA"));

  // History visibility
  const [historyExpanded, setHistoryExpanded] = useState(true);

  // ── Charge history query ─────────────────────────────────────────────────
  const { data: chargeHistory = [] } = useQuery<HistoryRow[]>({
    queryKey: [`/api/factory/containers/${container?.id}/post-offload-charges`],
    enabled: !!container?.id,
    select: (rows: HistoryRow[]) => rows,
  });

  const activeCharges = chargeHistory.filter((r) => !r.deletedAt);
  const undoneCharges = chargeHistory.filter((r) => !!r.deletedAt);

  // ── Create mutation ──────────────────────────────────────────────────────
  const postOffloadMutation = useMutation({
    mutationFn: async ({
      containerId,
      charges: c,
      txDate: d,
    }: {
      containerId: number;
      charges: {
        description: string;
        amount: string;
        currencyCode: string;
        ledgerAccountId: number | null;
        supplierId: number | null;
      }[];
      txDate: string;
    }) => {
      const res = await factoryApiRequest("POST", `/api/factory/containers/${containerId}/post-offload-charges`, {
        charges: c,
        txDate: d,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to save charges");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (container) invalidateChargeQueries(container.id);
      setCreateResult(data);
      setNewCharges([]);
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ── Edit mutation ────────────────────────────────────────────────────────
  const editMutation = useMutation({
    mutationFn: async ({ containerId, chargeId, body }: { containerId: number; chargeId: number; body: any }) => {
      const res = await factoryApiRequest(
        "PATCH",
        `/api/factory/containers/${containerId}/post-offload-charges/${chargeId}`,
        body
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update charge");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (container) invalidateChargeQueries(container.id);
      setEditResult(data);
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ── Legacy rebuild mutation ──────────────────────────────────────────────
  const rebuildMutation = useMutation({
    mutationFn: async ({
      containerId,
      chargeId,
      legacyBaselineRate,
      expectedVersion,
    }: {
      containerId: number;
      chargeId: number;
      legacyBaselineRate: number;
      expectedVersion: number;
    }) => {
      const res = await factoryApiRequest(
        "PATCH",
        `/api/factory/containers/${containerId}/post-offload-charges/${chargeId}/legacy-rebuild`,
        { legacyBaselineRate, expectedVersion }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to rebuild charge");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (container) invalidateChargeQueries(container.id);
      setEditResult(data);
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ── Undo mutation ────────────────────────────────────────────────────────
  const undoMutation = useMutation({
    mutationFn: async ({ containerId, chargeId, body }: { containerId: number; chargeId: number; body: any }) => {
      const res = await factoryApiRequest(
        "DELETE",
        `/api/factory/containers/${containerId}/post-offload-charges/${chargeId}`,
        body
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to undo charge");
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (container) invalidateChargeQueries(container.id);
      if (data.alreadyUndone) {
        toast({ title: "Already undone", description: "This charge was already reversed." });
        setUndoCharge(null);
      } else {
        setUndoResult(data);
        setUndoCharge(null);
      }
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleClose = () => {
    setNewCharges([]);
    setCreateResult(null);
    setEditingCharge(null);
    setEditResult(null);
    setUndoCharge(null);
    setUndoResult(null);
    onClose();
  };

  const startEdit = (charge: HistoryRow) => {
    setEditingCharge(charge);
    setEditDesc(charge.description);
    setEditAmount(charge.amount);
    setEditCcy(charge.currencyCode || "USD");
    setEditLedgerId(charge.ledgerAccountId ? String(charge.ledgerAccountId) : "");
    setEditTxDate(new Date().toLocaleDateString("en-CA"));
    setEditLegacyRate("");
    setEditResult(null);
  };

  const handleSaveEdit = () => {
    if (!container || !editingCharge) return;
    const isLegacy = editingCharge.supplierLockedRateBefore === null;
    const body: {
      description: string;
      amount: string;
      currencyCode: string;
      ledgerAccountId: number | null;
      txDate: string;
      expectedVersion: number;
      legacyBaselineRate?: number;
    } = {
      description: editDesc || "Post-offload charge",
      amount: editAmount,
      currencyCode: editCcy,
      ledgerAccountId: editLedgerId ? parseInt(editLedgerId) : null,
      txDate: editTxDate,
      expectedVersion: editingCharge.version,
    };
    if (isLegacy && editLegacyRate) body.legacyBaselineRate = parseFloat(editLegacyRate);

    wrapAdminAction(
      () => editMutation.mutate({ containerId: container.id, chargeId: editingCharge.id, body }),
      "Edit Post-Offload Charge"
    );
  };

  const handleLegacyRebuild = () => {
    if (!container || !editingCharge) return;
    const rate = parseFloat(editLegacyRate);
    if (!rate || rate <= 0) {
      toast({
        title: "Enter supplier rate",
        description: "Provide the supplier locked rate immediately before this charge.",
        variant: "destructive",
      });
      return;
    }
    wrapAdminAction(
      () =>
        rebuildMutation.mutate({
          containerId: container.id,
          chargeId: editingCharge.id,
          legacyBaselineRate: rate,
          expectedVersion: editingCharge.version,
        }),
      "Legacy Rebuild — Supplier Rate"
    );
  };

  const handleConfirmUndo = () => {
    if (!container || !undoCharge) return;
    const isLegacy = undoCharge.supplierLockedRateBefore === null;
    if (isLegacy && !undoLegacyRate) {
      toast({
        title: "Enter baseline rate",
        description: "Provide the supplier locked rate before this charge to undo it.",
        variant: "destructive",
      });
      return;
    }
    const body: { undoDate: string; expectedVersion: number; legacyBaselineRate?: number } = {
      undoDate,
      expectedVersion: undoCharge.version,
    };
    if (isLegacy && undoLegacyRate) body.legacyBaselineRate = parseFloat(undoLegacyRate);

    wrapAdminAction(
      () => undoMutation.mutate({ containerId: container.id, chargeId: undoCharge.id, body }),
      "Undo Post-Offload Charge"
    );
  };

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
                      <Select value={editLedgerId} onValueChange={setEditLedgerId}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select account (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">None</SelectItem>
                          {ledgerAccounts.map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>
                              {a.code ? `${a.code} - ${a.name}` : a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
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
      {AdminDialog}
    </>
  );
}
