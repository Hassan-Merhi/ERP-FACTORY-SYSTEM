/**
 * "Add Account to Agent Ledger" dialog.
 *
 * Extracted from pages/Agents.tsx; markup, styling, and test ids are
 * unchanged.
 */
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { drCrClass } from "@/lib/formatNumber";
import type { Account } from "./agentStatementMath";

interface AddAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: string;
  onSearchChange: (value: string) => void;
  availableAccounts: Account[];
  loading: boolean;
  formatAmount: (value: number) => string;
  onAdd: (account: Account) => void;
}

export function AddAgentDialog({
  open,
  onOpenChange,
  search,
  onSearchChange,
  availableAccounts,
  loading,
  formatAmount,
  onAdd,
}: AddAgentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Account to Agent Ledger</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, code or type..."
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              className="pl-9"
              autoFocus
              data-testid="input-add-agent-search"
            />
          </div>
          <div className="max-h-80 overflow-y-auto border rounded-xl divide-y">
            {loading ? (
              <div className="p-4 space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : availableAccounts.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">No accounts found</div>
            ) : (
              availableAccounts.slice(0, 100).map((account) => (
                <button
                  key={account.id}
                  className="w-full px-4 py-3 text-left hover-elevate flex items-center gap-3"
                  onClick={() => {
                    onAdd(account);
                    onOpenChange(false);
                  }}
                  data-testid={`button-add-account-${account.id}`}
                >
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0">
                    {account.name
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((w) => w[0])
                      .join("")
                      .toUpperCase() || "—"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{account.name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{account.type}</p>
                  </div>
                  {account.balance !== 0 && (
                    <span className="text-xs tabular-nums text-muted-foreground shrink-0 font-mono">
                      {formatAmount(Math.abs(account.balance))}{" "}
                      <span className={drCrClass(account.balanceSide)}>{account.balanceSide ?? ""}</span>
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
