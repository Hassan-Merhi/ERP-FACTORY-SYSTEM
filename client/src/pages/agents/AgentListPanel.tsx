/**
 * Agent list panel (left side of the Agent Ledger page).
 *
 * Extracted from pages/Agents.tsx; markup, styling, and test ids are
 * unchanged.
 */
import { Search, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
}: AgentListPanelProps) {
  return (
    <div className="w-72 shrink-0 border-r flex flex-col h-full overflow-hidden bg-muted/20">
      {/* Panel header */}
      <div className="px-4 pt-4 pb-3 border-b space-y-3 bg-background">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
              <Users className="h-4 w-4 text-primary" />
            </div>
            <span className="text-sm font-bold tracking-tight">Agent Ledger</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs gap-1"
            onClick={() => {
              onOpenAddDialog();
            }}
            data-testid="button-add-agent"
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search agents..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-8 h-8 text-sm bg-muted/50 border-transparent focus:border-border focus:bg-background"
            data-testid="input-agent-search"
          />
        </div>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
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
                className={`flex items-center gap-2.5 rounded-xl p-2 group transition-colors cursor-pointer
                  ${isSelected ? "bg-primary/10 ring-1 ring-primary/20" : "hover:bg-muted/60"}`}
                data-testid={`agent-row-${account.id}`}
              >
                {/* Avatar */}
                <button
                  className="flex-1 flex items-center gap-2.5 text-left min-w-0"
                  onClick={() => onSelect(account)}
                  data-testid={`button-select-agent-${account.id}`}
                >
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 text-xs font-bold
                    ${isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                  >
                    {initials || "—"}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate leading-tight">{account.name}</p>
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
                  className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0"
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
