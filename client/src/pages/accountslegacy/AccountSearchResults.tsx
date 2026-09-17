/**
 * Command-palette style account search results shown while the Accounts
 * Overview search box has a query.
 *
 * Split out of AccountsLegacy.tsx unchanged, including the Dr/Cr colouring and
 * the hide-balances permission gate.
 */
import { ArrowRight, Pencil, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AccountsLegacyModel } from "./useAccountsLegacyModel";

export function AccountSearchResults({ model }: { model: AccountsLegacyModel }) {
  const { filteredAccounts, hideBalances } = model;

  if (filteredAccounts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Search className="w-8 h-8 mb-3 opacity-30" />
        <p className="text-sm font-medium">No accounts found</p>
        <p className="text-xs mt-1 opacity-70">Try a different name or account code</p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border overflow-hidden divide-y">
      {filteredAccounts.map((acc) => {
        const balanceSide = acc.balanceSide || (acc.balance >= 0 ? "Dr" : "Cr");
        return (
          <div
            key={acc.id}
            className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors group"
          >
            <button
              data-testid={`button-search-account-${acc.accountId}`}
              className="flex flex-1 min-w-0 items-center gap-3 text-left"
              onClick={() => {
                model.handleAccountChange(acc.id);
                model.setSearchTerm("");
              }}
            >
              <div className="flex-1 min-w-0 flex items-center gap-2.5">
                <span className="text-sm font-medium truncate">{acc.name}</span>
                {acc.accountId && (
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0">#{acc.accountId}</span>
                )}
              </div>
              {!hideBalances && (
                <span
                  className={cn(
                    "font-mono tabular-nums text-sm font-medium shrink-0",
                    balanceSide === "Dr" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                  )}
                >
                  {model.formatAmountForAccount(Math.abs(acc.balance), acc.type)}
                  <span className="ml-1 text-[10px] opacity-60">{balanceSide}</span>
                </span>
              )}
            </button>
            {acc.type === "ledger" && (
              <button
                type="button"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => model.openEditAccountDialog(acc)}
                title="Edit account"
                aria-label={`Edit ${acc.name}`}
                data-testid={`button-edit-account-${acc.accountId}`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          </div>
        );
      })}
    </div>
  );
}
