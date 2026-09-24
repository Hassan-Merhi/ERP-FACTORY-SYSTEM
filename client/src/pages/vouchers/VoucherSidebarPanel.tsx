import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import {
  Plus,
  Search,
  Loader2,
  ArrowDownCircle,
  ArrowUpCircle,
  BookOpen,
  ArrowLeftRight,
  ClipboardList,
  SlidersHorizontal,
  FileText,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Account {
  id: number;
  name: string;
  type: "ledger" | "bank" | "supplier" | "employee" | "fixedAsset" | "factorySupplier";
  code: string;
  balance?: number;
}

interface VoucherSidebarPanelProps {
  sidebarAccounts: Account[];
  activeTab: string;
  onTabChange: (tab: unknown) => void;
  isFactoryMode: boolean;
  onAccountSelect: (account: Account) => void;
  getAccountBalance: (type: string, id: number) => number;
  formatAmount: (amount: number) => string;
  isAutoCreating?: boolean;
  onCreateAccount?: () => void;
  activeRowIndex: number | null;
  selectedAccountId: number | null;
  selectedAccountType: string | null;
}

export function VoucherSidebarPanel({
  sidebarAccounts,
  activeTab,
  onTabChange,
  isFactoryMode,
  onAccountSelect,
  getAccountBalance,
  formatAmount,
  isAutoCreating,
  onCreateAccount,
  activeRowIndex,
  selectedAccountId,
  selectedAccountType,
}: VoucherSidebarPanelProps) {
  const [sidebarSearchValue, setSidebarSearchValue] = useState("");
  const [sidebarHighlightedIndex, setSidebarHighlightedIndex] = useState(0);

  const sidebarGroups = [
    {
      label: "Financial",
      color: "#3b82f6",
      items: [
        { key: "payment", label: "Payment", icon: ArrowDownCircle },
        { key: "receipt", label: "Receipt", icon: ArrowUpCircle },
        { key: "journal", label: "Journal", icon: BookOpen },
      ],
    },
    {
      label: "Adjustments",
      color: "#f59e0b",
      items: [
        { key: "transfer", label: "Stock Transfer", icon: ArrowLeftRight },
        { key: "transferorder", label: "Transfer Order", icon: ClipboardList },
        { key: "adjustment", label: "Adjustment", icon: SlidersHorizontal },
        { key: "creditnote", label: "Credit Note", icon: FileText },
      ],
    },
  ];

  const visibleSidebarGroups = isFactoryMode ? sidebarGroups.filter((g) => g.label !== "Adjustments") : sidebarGroups;

  const filteredSidebarAccounts = useMemo(() => {
    if (!sidebarSearchValue.trim()) return sidebarAccounts;
    return sidebarAccounts.filter((acc) => searchAny(sidebarSearchValue, acc.name, acc.code));
  }, [sidebarAccounts, sidebarSearchValue]);

  const isFinancialTab = ["payment", "receipt", "journal"].includes(activeTab);

  return (
    <aside className="w-full lg:w-64 flex-shrink-0 space-y-6">
      <nav className="space-y-6">
        {visibleSidebarGroups.map((group) => (
          <div key={group.label} className="space-y-2">
            <h3 className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">{group.label}</h3>
            <div className="space-y-1">
              {group.items.map((item) => (
                <button
                  key={item.key}
                  onClick={() => onTabChange(item.key)}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md transition-all duration-200",
                    activeTab === item.key
                      ? "bg-primary text-primary-foreground shadow-sm scale-[1.02]"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  )}
                  data-testid={`button-tab-${item.key}`}
                >
                  <item.icon
                    className={cn("h-4 w-4", activeTab === item.key ? "text-primary-foreground" : "")}
                    style={{ color: activeTab === item.key ? undefined : group.color }}
                  />
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {isFinancialTab && (
        <Card className="flex flex-col max-h-[60vh] lg:max-h-[calc(100vh-25rem)]">
          <div className="p-4 border-b">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-semibold">Accounts</h3>
              {onCreateAccount && (
                <Button type="button" variant="outline" size="sm" onClick={onCreateAccount} className="h-7 px-2">
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  New
                </Button>
              )}
            </div>
            <div className="relative">
              {isAutoCreating ? (
                <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
              ) : (
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              )}
              <Input
                placeholder="Search accounts..."
                value={sidebarSearchValue}
                onChange={(e) => {
                  setSidebarSearchValue(e.target.value);
                  setSidebarHighlightedIndex(0);
                }}
                className="pl-9 h-8 text-sm"
                data-testid="input-sidebar-account-search"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            <div className="space-y-1">
              {filteredSidebarAccounts.length === 0 ? (
                <div className="text-center py-8 text-xs text-muted-foreground">No accounts found</div>
              ) : (
                filteredSidebarAccounts.map((account, idx) => {
                  const isHighlighted = idx === sidebarHighlightedIndex && activeRowIndex !== null;
                  const isSelected = selectedAccountId === account.id && selectedAccountType === account.type;
                  const balance = getAccountBalance(account.type, account.id);

                  return (
                    <button
                      key={`${account.type}-${account.id}`}
                      type="button"
                      onClick={() => onAccountSelect(account)}
                      className={cn(
                        "w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between gap-2",
                        isHighlighted && "bg-accent",
                        isSelected ? "bg-primary/10" : "hover:bg-muted"
                      )}
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
      )}
    </aside>
  );
}
