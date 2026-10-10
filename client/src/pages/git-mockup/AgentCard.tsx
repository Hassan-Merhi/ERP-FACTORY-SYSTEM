import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  Check,
  Pencil,
  Plus,
  RotateCcw,
  StickyNote,
  Trash2,
  XIcon,
  MessageCircle,
  CheckCircle2,
  ArrowUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { fmt, clientReallocate } from "./helpers";
import { sendAgentCardToWhatsApp } from "./agentCardWaSend";
import { AgentCardTable } from "./AgentCardTable";
import { AgentCardTransit } from "./AgentCardTransit";
import type { AgentDutySummary, ApiAllocatedRow, ApiAllocStatus } from "./types";
import { WARNING_META } from "./types";

interface AdjEntry {
  id: number;
  description: string;
  amount: number;
  type: string;
}
type PrepaidDesignation = { containerId: number };

export function AgentCard({
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
  const [_replaceConfirmDiff, setReplaceConfirmDiff] = useState(false);
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
    openBalance: _openBalance,
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
    exact: { label: "Exact match", cls: "bg-green-700 text-white" },
    fuzzy: { label: "Fuzzy match", cls: "bg-amber-600 text-white" },
    unmapped: { label: "No mapping", cls: "bg-muted text-muted-foreground border" },
  }[matchConfidence];

  return (
    <>
      <div className="space-y-0" data-testid={`agent-card-${agentName}`}>
        {waGroupChatId && (
          <div className="flex justify-end mb-1">
            <button
              type="button"
              onClick={sendToWhatsApp}
              disabled={waSending}
              title={`Send ${agentName} balance to WhatsApp`}
              data-testid={`button-wa-send-${agentName}`}
              className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-green-600 text-white text-xs font-semibold disabled:opacity-60 shadow-xs"
            >
              {waSending ? (
                <span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
              ) : (
                <MessageCircle className="h-3.5 w-3.5" />
              )}
              {waSending ? "Sending…" : "Send to WhatsApp"}
            </button>
          </div>
        )}

        <div className="rounded-md border border-border overflow-hidden shadow-xs">
          <div
            className="bg-slate-800 dark:bg-slate-900 text-white px-4 py-2.5 grid min-h-11"
            style={{ gridTemplateColumns: "1fr auto 1fr" }}
          >
            <span />
            <span className="font-bold tracking-widest text-sm uppercase self-center text-center">{agentName}</span>
            <span className="flex justify-end items-center">
              <Badge className={cn("text-[10px] no-default-active-elevate shrink-0", confidenceBadge.cls)}>
                {confidenceBadge.label}
              </Badge>
            </span>
          </div>

          {warnings.map((code) => {
            const meta = WARNING_META[code];
            const Icon = meta.icon;
            return (
              <div key={code} className={cn("px-3 py-1.5 border-b text-xs flex gap-2 items-start", meta.className)}>
                <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{meta.message}</span>
              </div>
            );
          })}

          {(editingNote || note) && (
            <div className="px-3 py-2 border-b bg-amber-50/60 dark:bg-amber-950/15 flex items-start gap-2 min-h-8">
              <StickyNote className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
              {editingNote ? (
                <div className="flex-1 flex items-start gap-1.5">
                  <textarea
                    autoFocus
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        saveNote();
                      }
                      if (e.key === "Escape") cancelNote();
                    }}
                    placeholder="e.g. Peage $400 · Road fees $530"
                    rows={2}
                    className="flex-1 text-xs rounded-sm border border-amber-300 dark:border-amber-700 bg-white dark:bg-amber-950/30 px-2 py-1 text-amber-900 dark:text-amber-200 resize-none focus:outline-hidden focus:ring-1 focus:ring-amber-400"
                    data-testid={`input-note-${agentName}`}
                  />
                  <button
                    onClick={saveNote}
                    title="Save"
                    className="mt-0.5 text-green-700 dark:text-green-400 hover:text-green-900"
                    data-testid={`button-save-note-${agentName}`}
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    onClick={cancelNote}
                    title="Cancel"
                    className="mt-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="flex-1 flex items-start justify-between gap-2">
                  <p className="text-xs text-amber-800 dark:text-amber-300 whitespace-pre-wrap leading-relaxed">
                    {note}
                  </p>
                  <button
                    onClick={() => {
                      setDraftNote(note);
                      setEditingNote(true);
                    }}
                    title="Edit note"
                    className="shrink-0 text-amber-500 hover:text-amber-700 dark:hover:text-amber-300"
                    data-testid={`button-edit-note-${agentName}`}
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="border-b">
            {adjustments.length > 0 && (
              <div className="px-3 pt-2 space-y-1">
                {adjustments.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 text-foreground truncate">{a.description}</span>
                    <span
                      className={cn(
                        "font-semibold tabular-nums shrink-0",
                        a.type === "debit" ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"
                      )}
                    >
                      {a.type === "debit" ? "+" : "−"}${fmt(a.amount, 0)}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] shrink-0 no-default-active-elevate",
                        a.type === "debit" ? "text-green-700 border-green-400" : "text-red-600 border-red-400"
                      )}
                    >
                      {a.type === "debit" ? "Dr" : "Cr"}
                    </Badge>
                    <button
                      onClick={() => deleteAdjMutation.mutate(a.id)}
                      disabled={deleteAdjMutation.isPending}
                      className="shrink-0 text-muted-foreground hover:text-red-500 transition-colors disabled:opacity-40"
                      title="Remove"
                      data-testid={`button-delete-adj-${a.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {showAdjForm ? (
              <div className="px-3 py-2 flex items-center gap-1.5 flex-wrap">
                <input
                  autoFocus
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveAdj()}
                  placeholder="Description (e.g. Peage, Road fees…)"
                  className="flex-1 min-w-[140px] text-xs rounded-sm border border-input bg-background px-2 py-1 focus:outline-hidden focus:ring-1 focus:ring-ring"
                  data-testid={`input-adj-desc-${agentName}`}
                />
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={newAmount}
                  onChange={(e) => setNewAmount(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveAdj()}
                  placeholder="Amount"
                  className="w-24 text-xs rounded-sm border border-input bg-background px-2 py-1 focus:outline-hidden focus:ring-1 focus:ring-ring text-right"
                  data-testid={`input-adj-amount-${agentName}`}
                />
                <div className="flex rounded-sm border border-input overflow-hidden text-[10px] font-bold shrink-0">
                  <button
                    type="button"
                    onClick={() => setNewType("debit")}
                    className={cn(
                      "px-2.5 py-1 transition-colors",
                      newType === "debit"
                        ? "bg-green-600 text-white"
                        : "bg-background text-muted-foreground hover:bg-muted"
                    )}
                    data-testid={`button-adj-debit-${agentName}`}
                  >
                    Dr
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewType("credit")}
                    className={cn(
                      "px-2.5 py-1 transition-colors",
                      newType === "credit"
                        ? "bg-red-600 text-white"
                        : "bg-background text-muted-foreground hover:bg-muted"
                    )}
                    data-testid={`button-adj-credit-${agentName}`}
                  >
                    Cr
                  </button>
                </div>
                <button
                  type="button"
                  onClick={saveAdj}
                  disabled={createAdjMutation.isPending}
                  className="px-2.5 py-1 rounded-sm bg-primary text-primary-foreground text-[10px] font-semibold disabled:opacity-50 shrink-0"
                  data-testid={`button-adj-save-${agentName}`}
                >
                  {createAdjMutation.isPending ? "…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAdjForm(false);
                    setNewDesc("");
                    setNewAmount("");
                    setNewType("debit");
                  }}
                  className="p-1 text-muted-foreground hover:text-foreground"
                  title="Cancel"
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <div className="px-3 py-1.5 flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowAdjForm(true)}
                  className="flex items-center justify-center h-5 w-5 rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                  title="Add manual entry"
                  data-testid={`button-adj-add-${agentName}`}
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>

          {isReconciled && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 dark:bg-green-950/20 border-b border-green-200 dark:border-green-800 text-xs text-green-800 dark:text-green-300">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0" />
              <span>Manual entries reconcile with container remainder — balance confirmed</span>
            </div>
          )}
          {isCustomOrder && (
            <div className="flex items-center gap-2 px-3 py-1 bg-blue-50 dark:bg-blue-950/20 border-b border-blue-200 dark:border-blue-800 text-xs text-blue-800 dark:text-blue-300">
              <ArrowUp className="h-3 w-3 shrink-0" />
              <span className="font-semibold">Custom priority order active</span>
              <span className="text-blue-600 dark:text-blue-400">— overpayment will be allocated top-to-bottom</span>
              <button
                onClick={resetOrder}
                className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-sm border border-blue-300 dark:border-blue-700 hover:bg-blue-100 dark:hover:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium"
                data-testid={`button-reset-order-${agentName}`}
              >
                <RotateCcw className="h-3 w-3" />
                Reset to auto (FIFO)
              </button>
            </div>
          )}
          {isDbOverride && prepaidTransitRows.length > 0 && (
            <div className="flex justify-end px-3 py-1 border-b">
              <button
                onClick={() => setAllPrepaidMutation.mutate([])}
                className="flex items-center gap-1 px-2 py-0.5 rounded-sm border border-muted text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                data-testid={`button-reset-prepaid-transit-${agentName}`}
              >
                <RotateCcw className="h-3 w-3" />
                Reset to auto
              </button>
            </div>
          )}

          <AgentCardTable
            agentName={agentName}
            prepaidTransitRows={prepaidTransitRows}
            visibleOpenPartial={visibleOpenPartial}
            openAndPartial={openAndPartial}
            isReconciled={isReconciled}
            showCleared={showCleared}
            setShowCleared={setShowCleared}
            isDbOverride={isDbOverride}
            effectivePrepaidIds={effectivePrepaidIds}
            setAllPrepaidMutate={(ids) => setAllPrepaidMutation.mutate(ids)}
            remainingTransitRows={remainingTransitRows}
            setReplaceTarget={setReplaceTarget}
            setReplaceAmountWarning={setReplaceAmountWarning}
            setReplaceConfirmDiff={setReplaceConfirmDiff}
            isCustomOrder={isCustomOrder}
            moveRow={moveRow}
            moveToTop={moveToTop}
            ledgerBalance={ledgerBalance}
            openSum={openSum}
            hasBalance={hasBalance}
            hasAdjustments={hasAdjustments}
            adjustedBalance={adjustedBalance}
            isMismatch={isMismatch}
            allBudgetDesignated={allBudgetDesignated}
            clearedRows={clearedRows}
          />

          {activePreviewRows.length > 0 && (
            <AgentCardTransit
              agentName={agentName}
              remainingTransitRows={remainingTransitRows}
              prepaidTransitRows={prepaidTransitRows}
              effectivePrepaidIds={effectivePrepaidIds}
              setAllPrepaidMutate={(ids) => setAllPrepaidMutation.mutate(ids)}
              prepaidBudget={prepaidBudget}
              designatedPrepaidSum={designatedPrepaidSum}
              transitTransporterFilter={transitTransporterFilter}
              setTransitTransporterFilter={setTransitTransporterFilter}
            />
          )}
        </div>
      </div>

      <Dialog
        open={replaceTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReplaceTarget(null);
            setReplaceAmountWarning(null);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Replace Prepaid Container</DialogTitle>
            <DialogDescription>
              Select an in-transit container to swap in place of{" "}
              <span className="font-mono font-semibold">{replaceTarget?.containerNumber}</span> ($
              {fmt(replaceTarget?.dutyFee ?? 0, 0)} duty).
            </DialogDescription>
          </DialogHeader>
          {replaceAmountWarning && (
            <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600" />
              <div className="flex-1">
                <p className="font-semibold mb-1">Duty amounts differ — click again to confirm</p>
                <p>
                  Old: <span className="font-mono font-semibold">${fmt(replaceAmountWarning.oldAmount, 0)}</span> → New:{" "}
                  <span className="font-mono font-semibold">${fmt(replaceAmountWarning.newAmount, 0)}</span>
                </p>
              </div>
            </div>
          )}
          <div className="max-h-64 overflow-y-auto rounded-md border divide-y text-xs">
            {remainingTransitRows.length === 0 ? (
              <p className="py-4 px-3 text-center text-muted-foreground italic">
                No other in-transit containers available.
              </p>
            ) : (
              remainingTransitRows.map((r) => {
                const amountsDiffer = Math.abs(r.dutyFee - (replaceTarget?.dutyFee ?? 0)) > 0.01;
                const isWarned = replaceAmountWarning?.newContainerId === r.id;
                return (
                  <button
                    key={r.id}
                    data-testid={`button-replace-pick-${r.id}`}
                    className={`w-full flex items-center gap-3 px-3 py-2 text-left hover-elevate ${isWarned ? "bg-amber-50/60 dark:bg-amber-950/20" : ""}`}
                    onClick={() => {
                      if (!replaceTarget) return;
                      if (amountsDiffer && !isWarned) {
                        setReplaceAmountWarning({
                          oldAmount: replaceTarget.dutyFee,
                          newAmount: r.dutyFee,
                          newContainerId: r.id,
                        });
                        return;
                      }
                      replacePrepaidMutation.mutate({
                        oldContainerId: replaceTarget.id,
                        newContainerId: r.id,
                        confirmDifferentAmount: amountsDiffer ? true : undefined,
                      });
                    }}
                  >
                    <span className="font-mono font-semibold text-sky-700 dark:text-sky-300 w-36 shrink-0">
                      {r.containerNumber}
                    </span>
                    <span className="text-muted-foreground grow">{r.supplierCode ?? r.supplierName ?? "—"}</span>
                    <span className="font-mono text-muted-foreground shrink-0">{r.numberPlate ?? ""}</span>
                    <span className="font-semibold text-right shrink-0 w-20">${fmt(r.dutyFee, 0)}</span>
                    {amountsDiffer && <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setReplaceTarget(null);
                setReplaceAmountWarning(null);
              }}
            >
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
