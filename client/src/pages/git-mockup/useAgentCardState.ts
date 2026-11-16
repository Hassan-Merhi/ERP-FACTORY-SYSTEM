// Extracted from ./AgentCard.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { clientReallocate } from "./helpers";
import { sendAgentCardToWhatsApp } from "./agentCardWaSend";
import type { AgentDutySummary, ApiAllocatedRow, ApiAllocStatus } from "./types";
import type { AdjEntry, PrepaidDesignation } from "./AgentCardTypes";

export function useAgentCardState({
  agent,
  companyId,
  waGroupChatId,
}: {
  agent: AgentDutySummary;
  companyId: number;
  waGroupChatId?: string;
}) {
  const { toast } = useToast();
  const [waSending, setWaSending] = useState(false);
  const [showCleared, setShowCleared] = useState(false);
  const [showAdjForm, setShowAdjForm] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newType, setNewType] = useState<"debit" | "credit">("debit");
  const [transitTransporterFilter, setTransitTransporterFilter] = useState<string | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<{ id: number; containerNumber: string; dutyFee: number } | null>(
    null
  );
  const [replaceAmountWarning, setReplaceAmountWarning] = useState<{
    oldAmount: number;
    newAmount: number;
    newContainerId: number;
  } | null>(null);
  const [, setReplaceConfirmDiff] = useState(false);
  const [pendingGraduationIds, setPendingGraduationIds] = useState<number[]>([]);

  // ── Custom order (localStorage) ───────────────────────────────────────────
  const storageKey = `agent-order-${agent.agentName}`;
  const [customOrder, setCustomOrder] = useState<number[] | null>(() => {
    try {
      const s = localStorage.getItem(storageKey);
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  });
  const saveOrder = useCallback(
    (order: number[] | null) => {
      if (order === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(order));
      setCustomOrder(order);
    },
    [storageKey]
  );
  const resetOrder = () => saveOrder(null);

  // ── Prepaid designations ──────────────────────────────────────────────────
  const prepaidQKey = [`/api/git/agent-prepaid/${companyId}/${encodeURIComponent(agent.agentName)}`];
  const { data: prepaidData } = useQuery<{ designations: PrepaidDesignation[] }>({
    queryKey: prepaidQKey,
    initialData: { designations: [] },
    staleTime: 120_000,
  });
  const dbPrepaidIds = useMemo(() => (prepaidData?.designations ?? []).map((d) => d.containerId), [prepaidData]);
  const isDbOverride = dbPrepaidIds.length > 0;

  const setAllPrepaidMutation = useMutation({
    mutationFn: (containerIds: number[]) =>
      apiRequest("POST", `/api/git/agent-prepaid/${companyId}/${encodeURIComponent(agent.agentName)}/set-all`, {
        containerIds,
      }),
    onMutate: async (containerIds) => {
      await queryClient.cancelQueries({ queryKey: prepaidQKey });
      const previous = queryClient.getQueryData(prepaidQKey);
      queryClient.setQueryData(prepaidQKey, { designations: containerIds.map((id) => ({ containerId: id })) });
      return { previous };
    },
    onSuccess: (_data, containerIds, context) => {
      queryClient.invalidateQueries({ queryKey: prepaidQKey });
      const prev =
        (context?.previous as { designations: { containerId: number }[] } | undefined)?.designations?.length ?? 0;
      if (containerIds.length > prev)
        toast({
          title: "Container designated as prepaid",
          description: "It now appears at the top of the list with a Prepaid badge.",
        });
    },
    onError: (e: ClientErrorLike, _vars, context) => {
      if (context?.previous !== undefined) queryClient.setQueryData(prepaidQKey, context.previous);
      toast({ title: "Failed to update prepaid", description: e.message, variant: "destructive" });
    },
  });

  const replacePrepaidMutation = useMutation({
    mutationFn: (body: { oldContainerId: number; newContainerId: number; confirmDifferentAmount?: boolean }) =>
      apiRequest("POST", `/api/git/agent-prepaid/${companyId}/${encodeURIComponent(agent.agentName)}/replace`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: prepaidQKey });
      setReplaceTarget(null);
      setReplaceAmountWarning(null);
    },
    onError: (e: ClientErrorLike) => toast({ title: "Replace failed", description: e.message, variant: "destructive" }),
  });

  // ── Note ──────────────────────────────────────────────────────────────────
  const noteQKey = [`/api/git/agent-note/${companyId}/${encodeURIComponent(agent.agentName)}`];
  const { data: noteData } = useQuery<{ note: string }>({ queryKey: noteQKey, staleTime: 120_000 });
  const note = noteData?.note ?? "";
  const noteMutation = useMutation({
    mutationFn: (newNote: string) =>
      apiRequest("PUT", `/api/git/agent-note/${companyId}/${encodeURIComponent(agent.agentName)}`, { note: newNote }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: noteQKey }),
  });
  const saveNote = () => {
    noteMutation.mutate(draftNote.trim());
    setEditingNote(false);
  };
  const cancelNote = () => {
    setDraftNote(note);
    setEditingNote(false);
  };

  // ── Adjustments ──────────────────────────────────────────────────────────
  const adjQKey = [`/api/git/agent-adjustments/${companyId}/${encodeURIComponent(agent.agentName)}`];
  const { data: adjData } = useQuery<AdjEntry[]>({ queryKey: adjQKey, initialData: [], staleTime: 120_000 });
  const adjustments: AdjEntry[] = useMemo(() => adjData ?? [], [adjData]);
  const createAdjMutation = useMutation({
    mutationFn: (body: { description: string; amount: number; type: "debit" | "credit" }) =>
      apiRequest("POST", `/api/git/agent-adjustments/${companyId}/${encodeURIComponent(agent.agentName)}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: adjQKey });
      setNewDesc("");
      setNewAmount("");
      setNewType("debit");
      setShowAdjForm(false);
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Failed to add entry", description: e.message, variant: "destructive" }),
  });
  const deleteAdjMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("DELETE", `/api/git/agent-adjustments/${companyId}/${encodeURIComponent(agent.agentName)}/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: adjQKey }),
    onError: (e: ClientErrorLike) =>
      toast({ title: "Failed to delete", description: e.message, variant: "destructive" }),
  });
  const saveAdj = () => {
    const amt = parseFloat(newAmount);
    if (!newDesc.trim() || isNaN(amt) || amt <= 0) {
      toast({
        title: "Invalid entry",
        description: "Please enter a description and a positive amount.",
        variant: "destructive",
      });
      return;
    }
    createAdjMutation.mutate({ description: newDesc.trim(), amount: amt, type: newType });
  };

  // ── sendToWhatsApp (delegated) ────────────────────────────────────────────
  const sendToWhatsApp = useCallback(async () => {
    await sendAgentCardToWhatsApp({
      agent,
      customOrder,
      dbPrepaidIds,
      adjustments,
      transitTransporterFilter,
      toast,
      setWaSending,
    });
  }, [agent, customOrder, dbPrepaidIds, adjustments, transitTransporterFilter, toast]);

  // ── Computed state ────────────────────────────────────────────────────────
  const {
    agentName,
    matchConfidence,
    ledgerBalance,
    offloadedDutyTotal,
    clearedByPayments,
    warnings,
    clearedRows,
    partialRows,
    openRows,
  } = agent;
  const activePreviewRows = useMemo(
    () => agent.activePreviewRows.filter((r) => !!(r.numberPlate ?? "").trim()),
    [agent.activePreviewRows]
  );
  const allOpenPartial = useMemo(() => [...partialRows, ...openRows], [partialRows, openRows]);
  const clearedTotal = useMemo(() => clearedRows.reduce((s, r) => s + r.dutyFee, 0), [clearedRows]);
  const remainderForOP = Math.max(clearedByPayments - clearedTotal, 0);

  const openAndPartial = useMemo((): ApiAllocatedRow[] => {
    if (!customOrder || customOrder.length === 0) return clientReallocate(allOpenPartial, remainderForOP);
    const orderMap = new Map(customOrder.map((id, i) => [id, i]));
    const sorted = [...allOpenPartial].sort((a, b) => {
      const ai = orderMap.has(a.id)
        ? orderMap.get(a.id)!
        : customOrder.length + allOpenPartial.findIndex((r) => r.id === a.id);
      const bi = orderMap.has(b.id)
        ? orderMap.get(b.id)!
        : customOrder.length + allOpenPartial.findIndex((r) => r.id === b.id);
      return ai - bi;
    });
    return clientReallocate(sorted, remainderForOP);
  }, [customOrder, allOpenPartial, remainderForOP]);

  const moveRow = useCallback(
    (containerId: number, direction: "up" | "down") => {
      const ids = openAndPartial.map((r) => r.id);
      const idx = ids.indexOf(containerId);
      if (idx === -1) return;
      const newIds = [...ids];
      if (direction === "up" && idx > 0) [newIds[idx], newIds[idx - 1]] = [newIds[idx - 1], newIds[idx]];
      else if (direction === "down" && idx < newIds.length - 1)
        [newIds[idx], newIds[idx + 1]] = [newIds[idx + 1], newIds[idx]];
      saveOrder(newIds);
    },
    [openAndPartial, saveOrder]
  );
  const moveToTop = useCallback(
    (containerId: number) => {
      const ids = openAndPartial.map((r) => r.id);
      if (ids.indexOf(containerId) <= 0) return;
      saveOrder([containerId, ...ids.filter((id) => id !== containerId)]);
    },
    [openAndPartial, saveOrder]
  );

  const openSum = openAndPartial.reduce((s, r) => s + r.remainingAmount, 0);
  const hasBalance = ledgerBalance !== null;
  const isCustomOrder = !!(customOrder && customOrder.length > 0);
  const netAdjustment = adjustments.reduce((s, a) => s + (a.type === "debit" ? a.amount : -a.amount), 0);
  const adjustedBalance = ledgerBalance !== null ? ledgerBalance - netAdjustment : null;
  const hasAdjustments = adjustments.length > 0;
  const isReconciled = hasAdjustments && adjustedBalance !== null && Math.abs(adjustedBalance) <= 0.01;
  const isMismatch =
    hasAdjustments && adjustedBalance !== null && !isReconciled && Math.abs(adjustedBalance - openSum) > 0.01;
  const prepaidBudget = Math.max(0, adjustedBalance ?? 0);
  const effectivePrepaidIds = dbPrepaidIds;
  const prepaidTransitSet = useMemo(() => new Set(effectivePrepaidIds), [effectivePrepaidIds]);
  const prepaidTransitRows = useMemo(
    () => activePreviewRows.filter((r) => prepaidTransitSet.has(r.id)),
    [activePreviewRows, prepaidTransitSet]
  );
  const remainingTransitRows = useMemo(
    () => activePreviewRows.filter((r) => !prepaidTransitSet.has(r.id)),
    [activePreviewRows, prepaidTransitSet]
  );
  const designatedPrepaidSum = useMemo(
    () => prepaidTransitRows.reduce((s, r) => s + Number(r.dutyFee ?? 0), 0),
    [prepaidTransitRows]
  );
  const minOpenRemaining =
    allOpenPartial.length > 0
      ? Math.min(...allOpenPartial.map((r) => r.remainingAmount).filter((a) => a > 0.01))
      : Infinity;
  const allBudgetDesignated =
    designatedPrepaidSum > 0 &&
    prepaidBudget > 0 &&
    (designatedPrepaidSum >= prepaidBudget - 0.01 ||
      prepaidBudget - designatedPrepaidSum <= (isFinite(minOpenRemaining) ? minOpenRemaining : 0) ||
      Math.abs(designatedPrepaidSum + netAdjustment - prepaidBudget) <= 1.0);
  const enhancedRemainder = allBudgetDesignated
    ? (offloadedDutyTotal ?? 0) * 2 + 1
    : remainderForOP + designatedPrepaidSum;
  const enhancedAllocated = useMemo(() => {
    let rem = enhancedRemainder;
    return openAndPartial.map((row) => {
      const needed = row.remainingAmount;
      if (needed <= 0) return { ...row, allocationStatus: "Cleared" as ApiAllocStatus };
      if (rem >= needed) {
        rem -= needed;
        return {
          ...row,
          clearedAmount: row.dutyFee,
          remainingAmount: 0,
          allocationStatus: "Cleared" as ApiAllocStatus,
        };
      } else if (rem > 0) {
        const extra = rem;
        rem = 0;
        return {
          ...row,
          clearedAmount: row.clearedAmount + extra,
          remainingAmount: row.remainingAmount - extra,
          allocationStatus: "Partially Cleared" as ApiAllocStatus,
        };
      }
      return row;
    });
  }, [openAndPartial, enhancedRemainder]);
  const enhancedCoveredIds = useMemo(
    () => new Set(enhancedAllocated.filter((r) => r.clearedAmount >= r.dutyFee).map((r) => r.id)),
    [enhancedAllocated]
  );
  const visibleOpenPartial = useMemo(
    () => openAndPartial.filter((r) => !enhancedCoveredIds.has(r.id)),
    [openAndPartial, enhancedCoveredIds]
  );

  // ── Stale-ID graduation ───────────────────────────────────────────────────
  const validTransitIdSet = useMemo(() => new Set(activePreviewRows.map((r) => r.id)), [activePreviewRows]);
  useEffect(() => {
    if (!isDbOverride || dbPrepaidIds.length === 0) return;
    const staleIds = dbPrepaidIds.filter((id) => !validTransitIdSet.has(id));
    if (staleIds.length === 0) return;
    setPendingGraduationIds((prev) => [...new Set([...prev, ...staleIds])]);
    setAllPrepaidMutation.mutate(dbPrepaidIds.filter((id) => validTransitIdSet.has(id)));
  }, [dbPrepaidIds, isDbOverride, setAllPrepaidMutation, validTransitIdSet]);
  useEffect(() => {
    if (pendingGraduationIds.length === 0) return;
    const openPartialIdSet = new Set(allOpenPartial.map((r) => r.id));
    const toPromote = pendingGraduationIds.filter((id) => openPartialIdSet.has(id));
    if (toPromote.length === 0) return;
    setPendingGraduationIds((prev) => prev.filter((id) => !openPartialIdSet.has(id)));
    const existing = customOrder ?? allOpenPartial.map((r) => r.id);
    saveOrder([...toPromote, ...existing.filter((id) => !toPromote.includes(id))]);
  }, [allOpenPartial, customOrder, pendingGraduationIds, saveOrder]);

  const confidenceBadge = {
    exact: { label: "Exact match", cls: "bg-emerald-500/15 text-emerald-200 border-emerald-400/35" },
    fuzzy: { label: "Fuzzy match", cls: "bg-amber-500/15 text-amber-200 border-amber-400/35" },
    unmapped: { label: "No mapping", cls: "bg-slate-500/20 text-slate-200 border-slate-400/30" },
  }[matchConfidence];

  // These cards are projections of the existing duty allocation state, not new calculations.
  const displayBalance = hasAdjustments ? adjustedBalance : ledgerBalance;
  const containerCount = clearedRows.length + partialRows.length + openRows.length + activePreviewRows.length;
  const upcomingDuty = remainingTransitRows.reduce((sum, row) => sum + row.dutyFee, 0);
  const balanceKind = displayBalance === null ? "" : displayBalance > 0 ? "Dr" : displayBalance < 0 ? "Cr" : "";
  return {
    activePreviewRows,
    adjustedBalance,
    adjustments,
    agentName,
    allBudgetDesignated,
    balanceKind,
    cancelNote,
    clearedRows,
    confidenceBadge,
    containerCount,
    createAdjMutation,
    deleteAdjMutation,
    designatedPrepaidSum,
    displayBalance,
    draftNote,
    editingNote,
    effectivePrepaidIds,
    hasAdjustments,
    hasBalance,
    isCustomOrder,
    isDbOverride,
    isMismatch,
    isReconciled,
    ledgerBalance,
    moveRow,
    moveToTop,
    newAmount,
    newDesc,
    newType,
    note,
    openAndPartial,
    openSum,
    prepaidBudget,
    prepaidTransitRows,
    remainingTransitRows,
    replaceAmountWarning,
    replacePrepaidMutation,
    replaceTarget,
    resetOrder,
    saveAdj,
    saveNote,
    sendToWhatsApp,
    setAllPrepaidMutation,
    setDraftNote,
    setEditingNote,
    setNewAmount,
    setNewDesc,
    setNewType,
    setReplaceAmountWarning,
    setReplaceConfirmDiff,
    setReplaceTarget,
    setShowAdjForm,
    setShowCleared,
    setTransitTransporterFilter,
    showAdjForm,
    showCleared,
    transitTransporterFilter,
    upcomingDuty,
    visibleOpenPartial,
    waGroupChatId,
    waSending,
    warnings,
  };
}
