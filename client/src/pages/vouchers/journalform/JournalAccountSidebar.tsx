import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { useJournalFormModel } from "./useJournalFormModel";

type Model = ReturnType<typeof useJournalFormModel>;

export function JournalAccountSidebar({ model }: { model: Model }) {
  const {
    showAccountSidebar,
    setShowAccountSidebar,
    activeJournalRow,
    handleOpenCreateAccountModal,
    journalAccountSearchTerm,
    setJournalAccountSearchTerm,
    setJournalAccountHighlightedIndex,
    journalAccountHighlightedIndex,
    filteredJournalAccounts,
    handleJournalAccountSelect,
    journalSidebarRef,
    journalEntries,
    getAccountBalance,
    formatAmount,
  } = model;

  if (!showAccountSidebar) return null;

  return (
    <Card className="hidden sm:flex flex-col w-full xl:w-80 xl:sticky xl:top-4 max-h-[60vh] xl:max-h-[calc(100dvh-12rem)] self-start">
      <div className="p-4 border-b">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold">Search Accounts</h3>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleOpenCreateAccountModal("journal", activeJournalRow ?? undefined)}
              data-testid="button-journal-create-account"
            >
              <Plus className="h-4 w-4 mr-1" />
              New
            </Button>
            <button
              type="button"
              onClick={() => setShowAccountSidebar(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
              data-testid="button-close-account-sidebar"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or code..."
            value={journalAccountSearchTerm}
            onChange={(event) => {
              setJournalAccountSearchTerm(event.target.value);
              setJournalAccountHighlightedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                if (filteredJournalAccounts.length > 0) {
                  setJournalAccountHighlightedIndex((previous) =>
                    Math.min(previous + 1, filteredJournalAccounts.length - 1)
                  );
                }
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                if (filteredJournalAccounts.length > 0) {
                  setJournalAccountHighlightedIndex((previous) => Math.max(previous - 1, 0));
                }
              } else if (event.key === "Enter") {
                if (
                  filteredJournalAccounts.length > 0 &&
                  journalAccountHighlightedIndex >= 0 &&
                  journalAccountHighlightedIndex < filteredJournalAccounts.length
                ) {
                  event.preventDefault();
                  handleJournalAccountSelect(filteredJournalAccounts[journalAccountHighlightedIndex]);
                }
              }
            }}
            className="pl-9"
            data-testid="input-journal-sidebar-search"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2" ref={journalSidebarRef}>
        <div className="space-y-1">
          {filteredJournalAccounts.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">No accounts found</div>
          ) : (
            filteredJournalAccounts.map((account, index) => {
              const isHighlighted = index === journalAccountHighlightedIndex && activeJournalRow !== null;
              const selectedEntry = journalEntries[activeJournalRow ?? 0];
              const isSelected = selectedEntry?.accountId === account.id && selectedEntry?.accountType === account.type;
              const balance = getAccountBalance(account.type, account.id);
              return (
                <button
                  key={`${account.type}-${account.id}`}
                  type="button"
                  onClick={() => handleJournalAccountSelect(account)}
                  className={cn(
                    "w-full text-left px-3 py-2 rounded-md text-sm hover-elevate active-elevate-2 flex items-center justify-between gap-2",
                    isHighlighted && "bg-accent",
                    isSelected && "bg-primary/10"
                  )}
                  data-testid={`journal-account-option-${index}`}
                >
                  <div className="flex-1 truncate">
                    <div className="font-medium truncate">{account.name}</div>
                  </div>
                  <div
                    className={cn(
                      "text-xs font-mono",
                      account.type === "employee" || account.type === "supplier"
                        ? balance >= 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-emerald-600 dark:text-emerald-400"
                        : balance >= 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400"
                    )}
                  >
                    {formatAmount(Math.abs(balance))}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </Card>
  );
}
