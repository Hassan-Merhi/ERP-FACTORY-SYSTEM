// Extracted from ./PostOffloadDialog.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useAdminOverride } from "@/hooks/use-admin-override";
import type { HistoryRow, MutationResult, PostOffloadCharge, PostOffloadDialogProps } from "./postoffloaddialog/types";
import { invalidateChargeQueries } from "./postoffloaddialog/utils";

export function usePostOffloadDialogState({ container, ledgerAccounts, onClose }: PostOffloadDialogProps) {
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
    mutationFn: async ({ containerId, chargeId, body }: { containerId: number; chargeId: number; body: unknown }) => {
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
    mutationFn: async ({ containerId, chargeId, body }: { containerId: number; chargeId: number; body: unknown }) => {
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
  return {
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
  };
}
