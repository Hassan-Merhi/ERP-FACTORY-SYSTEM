// Extracted from ./AgentCard.tsx to keep that module under the source-size cap.
import { Badge } from "@/components/ui/badge";
import { Boxes, Check, Coins, Plus, Trash2, Truck, Wallet, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmt } from "./helpers";
import { useAgentCardState } from "./useAgentCardState";

export function AgentCardSection({
  adjustments,
  agentName,
  createAdjMutation,
  deleteAdjMutation,
  newAmount,
  newDesc,
  newType,
  saveAdj,
  setNewAmount,
  setNewDesc,
  setNewType,
  setShowAdjForm,
  showAdjForm,
}: Pick<
  ReturnType<typeof useAgentCardState>,
  | "adjustments"
  | "agentName"
  | "createAdjMutation"
  | "deleteAdjMutation"
  | "newAmount"
  | "newDesc"
  | "newType"
  | "saveAdj"
  | "setNewAmount"
  | "setNewDesc"
  | "setNewType"
  | "setShowAdjForm"
  | "showAdjForm"
>) {
  return (
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
                  "text-[11px] shrink-0 no-default-active-elevate",
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
          <div className="flex rounded-sm border border-input overflow-hidden text-[11px] font-bold shrink-0">
            <button
              type="button"
              onClick={() => setNewType("debit")}
              className={cn(
                "px-2.5 py-1 transition-colors",
                newType === "debit" ? "bg-green-600 text-white" : "bg-background text-muted-foreground hover:bg-muted"
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
                newType === "credit" ? "bg-red-600 text-white" : "bg-background text-muted-foreground hover:bg-muted"
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
            className="px-2.5 py-1 rounded-sm bg-primary text-primary-foreground text-[11px] font-semibold disabled:opacity-50 shrink-0"
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
  );
}

export function AgentCardSection2({
  activePreviewRows,
  agentName,
  balanceKind,
  containerCount,
  displayBalance,
  upcomingDuty,
}: Pick<
  ReturnType<typeof useAgentCardState>,
  "activePreviewRows" | "agentName" | "balanceKind" | "containerCount" | "displayBalance" | "upcomingDuty"
>) {
  return (
    <div className="grid grid-cols-2 gap-2.5 border-b border-violet-200/50 bg-violet-50/40 p-3 dark:border-violet-500/15 dark:bg-slate-950/70 lg:grid-cols-4">
      <div className="flex min-w-0 items-center gap-3 rounded-xl border border-emerald-200/80 bg-emerald-50/80 px-3 py-3 dark:border-emerald-500/25 dark:bg-emerald-500/10">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
          <Wallet className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted-foreground">Account Balance</p>
          <p
            className={cn(
              "truncate text-lg font-bold tabular-nums",
              displayBalance !== null && displayBalance < 0
                ? "text-rose-700 dark:text-rose-400"
                : "text-emerald-800 dark:text-emerald-300"
            )}
            data-testid={`agent-balance-${agentName}`}
          >
            {displayBalance === null ? "Unavailable" : `${fmt(Math.abs(displayBalance), 0)}`}
            {balanceKind && <span className="ml-1 text-xs font-semibold">({balanceKind})</span>}
          </p>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-background/90 px-3 py-3 dark:bg-violet-500/10">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-700 dark:text-violet-300">
          <Boxes className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted-foreground">Containers</p>
          <p className="text-lg font-bold tabular-nums text-foreground">{containerCount}</p>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-background/90 px-3 py-3 dark:bg-violet-500/10">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-700 dark:text-indigo-300">
          <Truck className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted-foreground">In Transit</p>
          <p className="text-lg font-bold tabular-nums text-foreground">{activePreviewRows.length}</p>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-background/90 px-3 py-3 dark:bg-amber-500/10">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300">
          <Coins className="h-4.5 w-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted-foreground">Upcoming Duty</p>
          <p className="truncate text-lg font-bold tabular-nums text-foreground">${fmt(upcomingDuty, 0)}</p>
        </div>
      </div>
    </div>
  );
}

export function AgentCardSection3({
  agentName,
  cancelNote,
  draftNote,
  saveNote,
  setDraftNote,
}: Pick<ReturnType<typeof useAgentCardState>, "agentName" | "cancelNote" | "draftNote" | "saveNote" | "setDraftNote">) {
  return (
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
      <button onClick={cancelNote} title="Cancel" className="mt-0.5 text-muted-foreground hover:text-foreground">
        <XIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
