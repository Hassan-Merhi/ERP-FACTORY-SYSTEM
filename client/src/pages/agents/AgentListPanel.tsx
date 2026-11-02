/**
 * Agent list panel (left side of the Agent Ledger page).
 *
 * The panel uses premium light/dark styling while keeping agent selection,
 * add/remove controls, search behavior, and test ids unchanged.
 */
import { Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import type { Account } from "./agentStatementMath";

interface AgentListPanelProps {
  agentAccounts: Account[];
  hasAnyAgents: boolean;
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  selectedAccountId: string | null;
  onSelect: (account: Account) => void;
  onRemove: (accountId: string) => void;
  formatAmount: (value: number) => string;
  onOpenAddDialog: () => void;
  /** Phone layout: the list is the whole screen; tapping an agent opens the statement. */
  phone?: boolean;
}

export function AgentListPanel({
  agentAccounts,
  hasAnyAgents,
  loading,
  search,
  onSearchChange,
  selectedAccountId,
  onSelect,
  onRemove,
  formatAmount,
  onOpenAddDialog,
  phone = false,
}: AgentListPanelProps) {
  return (
    <div
      className={
        phone
          ? "flex w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm dark:border-blue-400/20 dark:bg-[#0b1b35]"
          : "flex h-full w-80 shrink-0 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm dark:border-blue-400/20 dark:bg-[#0b1b35] max-md:max-h-[min(42dvh,22rem)] max-md:w-full max-md:flex-none"
      }
      data-testid="agent-list-panel"
    >
      {/* Panel header */}
      <div className={`space-y-3 border-b border-slate-200/70 bg-gradient-to-b from-blue-50/80 to-white px-4 pb-4 pt-4 dark:border-blue-400/10 dark:from-[#10274a] dark:to-[#0b1b35] ${phone ? "rounded-t-2xl" : ""}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100 text-blue-600 shadow-sm ring-1 ring-blue-200/60 dark:bg-blue-500/15 dark:text-blue-400 dark:ring-blue-400/20">
              <Users className="h-4 w-4" />
            </div>
            <span className="text-base font-bold tracking-tight text-slate-900 dark:text-white">Agent Ledger</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className={phone
              ? "gap-1.5 border-blue-500 bg-blue-600 text-white shadow-sm hover:bg-blue-700 hover:text-white"
              : "h-9 gap-1.5 rounded-xl border-blue-500 bg-blue-600 px-3 text-xs font-semibold text-white shadow-sm shadow-blue-600/20 hover:bg-blue-700 hover:text-white"}
            onClick={() => {
              onOpenAddDialog();
            }}
            data-testid="button-add-agent"
          >
            <Plus className="h-3.5 w-3.5" />
            {phone ? "Add Account" : "Add"}
          </Button>
        </div>
        <SearchField
          value={search}
          onValueChange={onSearchChange}
          placeholder="Search agents..."
          className={`${phone ? "" : "h-10"} rounded-xl border-slate-200 bg-slate-100/80 text-sm shadow-inner shadow-slate-100/50 placeholder:text-slate-400 focus:border-blue-400 focus:bg-white dark:border-blue-400/15 dark:bg-[#142b4c] dark:shadow-none dark:placeholder:text-slate-400 dark:focus:bg-[#172f50]`}
          data-testid="input-agent-search"
        />
      </div>

      {/* Agent list */}
      <div className={phone ? "space-y-1 px-2 py-3" : "flex-1 space-y-1 overflow-y-auto px-2 py-3"}>
        {loading ? (
          <div className="p-2 space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : agentAccounts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 px-4 text-center">
            <div className="w-12 h-12 rounded-2xl bg-muted flex items-center justify-center">
              <Users className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-semibold">{hasAnyAgents ? "No results" : "No agents yet"}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {hasAnyAgents ? "Try a different search" : "Click Add to pin an account as an agent"}
              </p>
            </div>
          </div>
        ) : (
          agentAccounts.map((account) => {
            const isSelected = selectedAccountId === account.id;
            const initials = account.name
              .split(/\s+/)
              .slice(0, 2)
              .map((w) => w[0])
              .join("")
              .toUpperCase();
            const isCr = account.balanceSide?.toLowerCase() === "cr";
            return (
              <div
                key={account.id}
                className={`group flex cursor-pointer items-center gap-2.5 rounded-xl border p-2.5 transition-all duration-150
                  ${isSelected
                    ? "border-blue-400/70 bg-gradient-to-r from-blue-100 to-blue-50 shadow-sm ring-1 ring-blue-500/30 dark:border-blue-500/80 dark:from-[#17458a] dark:to-[#102b55] dark:shadow-[0_0_16px_rgba(37,99,235,0.16)] dark:ring-blue-400/30"
                    : "border-transparent hover:border-blue-200 hover:bg-blue-50/60 dark:hover:border-blue-400/20 dark:hover:bg-blue-400/10"}`}
                data-testid={`agent-row-${account.id}`}
              >
                {/* Avatar */}
                <button
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded-lg"
                  onClick={() => onSelect(account)}
                  data-testid={`button-select-agent-${account.id}`}
                >
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold shadow-sm
                    ${isSelected
                      ? "bg-blue-600 text-white dark:bg-blue-500 dark:text-white"
                      : "bg-slate-100 text-slate-600 dark:bg-slate-600/40 dark:text-slate-200"}`}
                  >
                    {initials || "—"}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold leading-tight text-slate-900 dark:text-slate-50">{account.name}</p>
                    {account.balance !== 0 ? (
                      <p
                        className={`text-xs tabular-nums font-mono mt-0.5 ${isCr ? "text-red-500 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}
                      >
                        {formatAmount(Math.abs(account.balance))}{" "}
                        <span className="font-sans font-medium">{account.balanceSide ?? ""}</span>
                      </p>
                    ) : (
                      <p className="text-xs text-muted-foreground mt-0.5">$0 — settled</p>
                    )}
                  </div>
                </button>
                <button
                  className="shrink-0 rounded-lg p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus:opacity-100 focus-visible:ring-2 focus-visible:ring-destructive group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100"
                  onClick={() => onRemove(account.id)}
                  data-testid={`button-remove-agent-${account.id}`}
                  title="Remove from Agent Ledger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
