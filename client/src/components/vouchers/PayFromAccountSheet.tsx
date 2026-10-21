/**
 * Mobile Pay From / Receive Into account sheet for Payment and Receipt
 * vouchers: searchable list of eligible cash, bank and loan accounts.
 * Extracted from PaymentReceiptTab.tsx; selection is reported to the parent.
 */
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { Account } from "@/components/AccountSidebar";

export function PayFromAccountSheet({
  open,
  onOpenChange,
  accountLabel,
  payFromSearch,
  setPayFromSearch,
  sidebarAccounts,
  payFromKeys,
  paymentAccountId,
  paymentAccountType,
  formatAmount,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
  accountLabel: string;
  payFromSearch: string;
  setPayFromSearch: (value: string) => void;
  sidebarAccounts: Account[];
  payFromKeys: Set<string>;
  paymentAccountId: number;
  paymentAccountType: string;
  formatAmount: (amount: number | string | null | undefined) => string;
  onSelect: (account: Account) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex flex-col p-0" style={{ height: "auto", maxHeight: "88vh" }}>
        <SheetHeader className="px-4 pt-4 pb-3 border-b shrink-0">
          <SheetTitle className="text-base">{accountLabel}</SheetTitle>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              autoFocus
              placeholder={`Search ${accountLabel.toLowerCase()}...`}
              value={payFromSearch}
              onChange={(e) => setPayFromSearch(e.target.value)}
              className="pl-9"
              data-testid="input-pay-from-mobile-search"
            />
          </div>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto min-h-0">
          {(() => {
            const search = payFromSearch.toLowerCase().replace(/[\s.-]/g, "");
            const filtered = sidebarAccounts.filter((a) => {
              // Only show cash / bank / loan eligible accounts in the Pay From sheet
              if (!payFromKeys.has(`${a.type}:${a.id}`)) return false;
              if (!payFromSearch) return true;
              return a.name
                .toLowerCase()
                .replace(/[\s.-]/g, "")
                .includes(search);
            });
            if (filtered.length === 0) {
              return (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {payFromSearch ? "No accounts match your search" : "No accounts available"}
                </div>
              );
            }
            return filtered.slice(0, 40).map((account) => {
              const isSelected = account.id === paymentAccountId && account.type === paymentAccountType;
              const bal = typeof account.balance === "string" ? parseFloat(account.balance) : (account.balance ?? null);
              return (
                <button
                  key={`${account.type}-${account.id}`}
                  type="button"
                  className={cn(
                    "w-full text-left px-4 py-3 border-b border-muted/40 flex items-center justify-between gap-3 active-elevate-2",
                    isSelected && "bg-accent"
                  )}
                  onClick={() => onSelect(account)}
                  data-testid={`pay-from-mobile-option-${account.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{account.name}</div>
                    {bal != null && (
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">{formatAmount(bal)}</div>
                    )}
                  </div>
                  {isSelected && <div className="h-2 w-2 rounded-full bg-primary shrink-0" />}
                </button>
              );
            });
          })()}
        </div>
      </SheetContent>
    </Sheet>
  );
}
