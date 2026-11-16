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
  Pencil,
  RotateCcw,
  StickyNote,
  MessageCircle,
  CheckCircle2,
  ArrowUp,
  Building2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt } from "./helpers";
import { AgentCardTable } from "./AgentCardTable";
import { AgentCardTransit } from "./AgentCardTransit";
import type { AgentDutySummary } from "./types";
import { WARNING_META } from "./types";
import { useAgentCardState } from "./useAgentCardState";
import { AgentCardSection, AgentCardSection2, AgentCardSection3 } from "./AgentCardSection";

export function AgentCard(props: { agent: AgentDutySummary; companyId: number; waGroupChatId?: string }) {
  const {
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
  } = useAgentCardState(props);

  return (
    <>
      <div className="space-y-2" data-testid={`agent-card-${agentName}`}>
        {waGroupChatId && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={sendToWhatsApp}
              disabled={waSending}
              title={`Send ${agentName} balance to WhatsApp`}
              data-testid={`button-wa-send-${agentName}`}
              className="inline-flex min-h-9 items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-emerald-900/15 transition-colors hover:bg-emerald-500 disabled:opacity-60"
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

        <div className="overflow-hidden rounded-2xl border border-violet-200/70 bg-card shadow-[0_10px_32px_-22px_rgba(76,29,149,0.4)] dark:border-violet-400/20 dark:shadow-[0_18px_48px_-22px_rgba(0,0,0,0.7)]">
          <div className="relative grid min-h-16 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-2 border-b border-violet-300/20 bg-gradient-to-r from-indigo-950 via-violet-950 to-indigo-950 px-3 py-3 text-white sm:px-5">
            <div className="flex justify-start">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-violet-300/25 bg-violet-500/25 text-violet-200 shadow-inner">
                <Building2 className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
            </div>
            <h3
              className="min-w-0 truncate text-center text-base font-extrabold uppercase tracking-wider text-white sm:text-lg"
              title={agentName}
            >
              {agentName}
            </h3>
            <div className="flex min-w-0 justify-end">
              <Badge
                className={cn(
                  "max-w-full truncate border px-2 py-1 text-[10px] font-semibold no-default-active-elevate sm:text-[11px]",
                  confidenceBadge.cls
                )}
              >
                {confidenceBadge.label}
              </Badge>
            </div>
          </div>

          <AgentCardSection2
            activePreviewRows={activePreviewRows}
            agentName={agentName}
            balanceKind={balanceKind}
            containerCount={containerCount}
            displayBalance={displayBalance}
            upcomingDuty={upcomingDuty}
          />

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
                <AgentCardSection3
                  agentName={agentName}
                  cancelNote={cancelNote}
                  draftNote={draftNote}
                  saveNote={saveNote}
                  setDraftNote={setDraftNote}
                />
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

          <AgentCardSection
            adjustments={adjustments}
            agentName={agentName}
            createAdjMutation={createAdjMutation}
            deleteAdjMutation={deleteAdjMutation}
            newAmount={newAmount}
            newDesc={newDesc}
            newType={newType}
            saveAdj={saveAdj}
            setNewAmount={setNewAmount}
            setNewDesc={setNewDesc}
            setNewType={setNewType}
            setShowAdjForm={setShowAdjForm}
            showAdjForm={showAdjForm}
          />

          {isReconciled && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 dark:bg-green-950/20 border-b border-green-200 dark:border-green-800 text-xs text-green-800 dark:text-green-300">
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0" />
              <span>Manual entries reconcile with container remainder — balance confirmed</span>
            </div>
          )}
          {isCustomOrder && (
            <div className="mx-3 my-2 flex flex-wrap items-center gap-2 rounded-xl border border-sky-200 bg-sky-50/80 px-3 py-2 text-xs text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300">
              <ArrowUp className="h-3 w-3 shrink-0" />
              <span className="font-semibold">Custom priority order active</span>
              <span className="text-blue-600 dark:text-blue-400">— overpayment will be allocated top-to-bottom</span>
              <button
                onClick={resetOrder}
                className="ml-auto flex min-h-7 items-center gap-1 rounded-lg border border-sky-300 bg-background/70 px-2.5 py-1 font-medium text-sky-700 transition-colors hover:bg-sky-100 dark:border-sky-400/30 dark:text-sky-200 dark:hover:bg-sky-500/20"
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
