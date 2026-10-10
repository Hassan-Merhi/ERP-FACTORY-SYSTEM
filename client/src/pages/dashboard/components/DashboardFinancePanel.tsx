import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  ChevronsUpDown,
  GripVertical,
  Plus,
  Wallet,
  X,
} from "lucide-react";

import { useDashboard } from "../useDashboard";

interface DashboardFinancePanelProps {
  dashboard: ReturnType<typeof useDashboard>;
}

export function DashboardFinancePanel({ dashboard }: DashboardFinancePanelProps) {
  const {
    formatAmount,
    formatCashAmount,
    appMode,
    modePrefix,
    setLocation,
    isFactoryMode,
    isAddDialogOpen,
    setIsAddDialogOpen,
    isAddPayableDialogOpen,
    setIsAddPayableDialogOpen,
    selectedAccountId,
    setSelectedAccountId,
    selectedPayableAccountId,
    setSelectedPayableAccountId,
    payableComboboxOpen,
    setPayableComboboxOpen,
    cashComboboxOpen,
    setCashComboboxOpen,
    profitData,
    isLoading,
    cashAccountsError,
    allAccounts,
    dashboardPayableAccounts,
    payableAccountsError,
    addAccountMutation,
    removeAccountMutation,
    addPayableAccountMutation,
    removePayableAccountMutation,
    dragCashRef,
    dragPayableRef,
    handleCashDrop,
    handlePayableDrop,
    availableCashAccounts,
    displayedCashAccounts,
    availablePayableAccounts,
    totalAvailable,
    totalPayable,
    netCashPosition,
  } = dashboard;

  return (
    <div className={cn("grid gap-4 sm:gap-6", !isFactoryMode ? "grid-cols-1 xl:grid-cols-2" : "grid-cols-1")}>
      {/* ── Net Position Breakdown ── */}
      <Card className="p-4 sm:p-6">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-semibold pl-3 border-l-[3px] border-primary">Net Position Breakdown</h3>
          <button
            onClick={() =>
              setLocation(
                modePrefix === ""
                  ? "/net-position-details"
                  : appMode === "properties"
                    ? "/properties/net-position-details"
                    : `${modePrefix}/net-position`
              )
            }
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
            data-testid="button-net-position-detail"
          >
            Full Breakdown
            <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        {!isLoading &&
          profitData &&
          (() => {
            const total = (profitData.forUsTotal ?? 0) + (profitData.onUsTotal ?? 0);
            const assetsPct = total > 0 ? Math.round(((profitData.forUsTotal ?? 0) / total) * 100) : 50;
            return (
              <div className="mb-4">
                <div className="flex justify-between text-xs font-medium mb-1.5">
                  <span className="text-chart-2">Assets {assetsPct}%</span>
                  <span className="text-destructive">Liabilities {100 - assetsPct}%</span>
                </div>
                <div className="h-2 rounded-full bg-destructive/15 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-chart-2 transition-all duration-700"
                    style={{ width: `${assetsPct}%` }}
                  />
                </div>
              </div>
            );
          })()}

        {profitData?.currency?.totalsProvisional && (
          <div
            className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
            role="status"
            data-testid="net-position-currency-warning"
          >
            Net Position is provisional: {profitData.currency.unresolvedLegacyEntryCount} legacy foreign-currency
            {profitData.currency.unresolvedLegacyEntryCount === 1 ? " entry remains" : " entries remain"} unresolved.
            Native currency totals are shown separately and were not revalued with today&apos;s rate.
          </div>
        )}
        {profitData?.currency && Object.keys(profitData.currency.nativeDebitByCurrency).length > 0 && (
          <div
            className="mb-4 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
            data-testid="net-position-currency-summary"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-semibold">Native currency balances</span>
              <span className="text-[11px] text-muted-foreground">{profitData.currency.rateConvention}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono">
              {Object.entries(profitData.currency.nativeDebitByCurrency).map(([currency, amount]) => (
                <span key={currency}>
                  {currency} {amount}
                </span>
              ))}
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center h-[200px]">
            <p className="text-muted-foreground">Loading...</p>
          </div>
        ) : (
          <div
            className={cn("grid gap-3", isFactoryMode ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-2")}
          >
            {/* What We Have */}
            <div className="rounded-md bg-chart-2/5 border border-chart-2/20 p-4">
              <h4 className="text-sm font-semibold text-chart-2 mb-3 flex items-center gap-2">
                <ArrowDownLeft className="h-3.5 w-3.5" />
                What We Have
              </h4>
              <div className="space-y-1.5 text-sm">
                {(profitData?.forUs?.breakdown ?? []).map((item, idx) => (
                  <div key={idx} className="flex justify-between gap-2">
                    <span className="text-muted-foreground truncate">{item.name}</span>
                    <span className="font-mono shrink-0">{formatAmount(item.value)}</span>
                  </div>
                ))}
                <div className="border-t border-chart-2/20 pt-2 mt-2 flex justify-between font-semibold">
                  <span>Total Assets</span>
                  <span className="font-mono text-chart-2">{formatAmount(profitData?.forUsTotal ?? 0)}</span>
                </div>
              </div>
            </div>

            {/* What We Owe */}
            <div className="rounded-md bg-destructive/5 border border-destructive/20 p-4">
              <h4 className="text-sm font-semibold text-destructive mb-3 flex items-center gap-2">
                <ArrowUpRight className="h-3.5 w-3.5" />
                What We Owe
              </h4>
              <div className="space-y-1.5 text-sm">
                {(profitData?.onUs?.breakdown ?? []).map((item, idx) => (
                  <div key={idx} className="flex justify-between gap-2">
                    <span className="text-muted-foreground truncate">{item.name}</span>
                    <span className="font-mono shrink-0 text-destructive">{formatAmount(item.value)}</span>
                  </div>
                ))}
                <div className="border-t border-destructive/20 pt-2 mt-2 flex justify-between font-semibold">
                  <span>Total Liabilities</span>
                  <span className="font-mono text-destructive">{formatAmount(profitData?.onUsTotal ?? 0)}</span>
                </div>
              </div>
            </div>

            {/* What We Spent — ERP only */}
            {!isFactoryMode && (
              <div className="rounded-md bg-orange-500/5 border border-orange-500/20 p-4">
                <h4 className="text-sm font-semibold text-orange-600 dark:text-orange-400 mb-3 flex items-center gap-2">
                  <Wallet className="h-3.5 w-3.5" />
                  What We Spent
                </h4>
                <div className="space-y-1.5 text-sm">
                  {(profitData?.expenses?.breakdown ?? []).map((item, idx) => (
                    <div key={idx} className="flex justify-between gap-2">
                      <span className="text-muted-foreground truncate">{item.name}</span>
                      <span className="font-mono shrink-0 text-orange-600 dark:text-orange-400">
                        {formatAmount(item.value)}
                      </span>
                    </div>
                  ))}
                  <div className="border-t border-orange-500/20 pt-2 mt-2 flex justify-between font-semibold">
                    <span>Total Expenses</span>
                    <span className="font-mono text-orange-600 dark:text-orange-400">
                      {formatAmount(profitData?.expensesTotal ?? 0)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Net Position result */}
            <div
              className={cn(
                "rounded-md p-4 flex flex-col justify-between",
                (profitData?.netPosition ?? 0) >= 0
                  ? "bg-chart-2/10 border border-chart-2/30"
                  : "bg-destructive/10 border border-destructive/30"
              )}
            >
              <h4 className="text-sm font-semibold mb-3">Net Position</h4>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Assets</span>
                  <span className="font-mono text-chart-2">{formatAmount(profitData?.forUsTotal ?? 0)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">− Liabilities</span>
                  <span className="font-mono text-destructive">{formatAmount(profitData?.onUsTotal ?? 0)}</span>
                </div>
                {!isFactoryMode && (
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">− Expenses</span>
                    <span className="font-mono text-orange-600 dark:text-orange-400">
                      {formatAmount(profitData?.expensesTotal ?? 0)}
                    </span>
                  </div>
                )}
                <div className="border-t pt-3 mt-2 flex justify-between items-baseline">
                  <span className="font-semibold">=</span>
                  <span
                    className={cn(
                      "text-2xl font-bold font-mono",
                      (profitData?.netPosition ?? 0) >= 0 ? "text-chart-2" : "text-destructive"
                    )}
                  >
                    {formatAmount(profitData?.netPosition ?? 0)}
                  </span>
                </div>
              </div>
              {profitData?.netPositionLabel && (
                <p
                  className={cn(
                    "text-xs font-medium mt-3 text-center py-1 rounded-xs",
                    (profitData.netPosition ?? 0) >= 0
                      ? "bg-chart-2/20 text-chart-2"
                      : "bg-destructive/20 text-destructive"
                  )}
                >
                  {profitData.netPositionLabel}
                </p>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ── Available & To Pay — ERP only ── */}
      {!isFactoryMode && (
        <Card className="p-0 overflow-hidden">
          {/* Summary bar */}
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-x border-b">
            <div className="p-4 sm:p-5 text-center bg-chart-2/5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-chart-2/70 mb-1">Available</p>
              <p className="text-xl sm:text-2xl font-bold font-mono text-chart-2" data-testid="text-total-available">
                {formatCashAmount(totalAvailable)}
              </p>
            </div>
            <div className="p-4 sm:p-5 text-center bg-destructive/5">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-destructive/70 mb-1">To Pay</p>
              <p className="text-xl sm:text-2xl font-bold font-mono text-destructive" data-testid="text-total-payable">
                {formatCashAmount(totalPayable)}
              </p>
            </div>
            <div className={cn("p-4 sm:p-5 text-center", netCashPosition >= 0 ? "bg-chart-2/5" : "bg-destructive/5")}>
              <p
                className={cn(
                  "text-[11px] font-semibold uppercase tracking-wider mb-1",
                  netCashPosition >= 0 ? "text-chart-2/70" : "text-destructive/70"
                )}
              >
                Net
              </p>
              <p
                className={cn(
                  "text-xl sm:text-2xl font-bold font-mono",
                  netCashPosition >= 0 ? "text-chart-2" : "text-destructive"
                )}
                data-testid="text-net-position"
              >
                {formatCashAmount(netCashPosition)}
              </p>
            </div>
          </div>

          {/* Two-col interior on lg */}
          <div className="grid grid-cols-1 lg:grid-cols-2 lg:divide-x">
            {/* ─── Available ─── */}
            <div className="p-4 sm:p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-chart-2 flex items-center gap-1.5">
                  <ArrowDownLeft className="h-4 w-4" />
                  Available
                </h3>
                <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline" data-testid="button-add-cash-account">
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Account to Available</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <label className="text-sm font-medium mb-2 block">Account</label>
                        <Popover open={cashComboboxOpen} onOpenChange={setCashComboboxOpen}>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              role="combobox"
                              aria-expanded={cashComboboxOpen}
                              className="w-full justify-between"
                              data-testid="select-account"
                            >
                              {selectedAccountId > 0
                                ? availableCashAccounts.find((acc) => acc.accountId === selectedAccountId)?.name ||
                                  "Select account..."
                                : "Search accounts..."}
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-full p-0" align="start">
                            <Command>
                              <CommandInput placeholder="Search accounts..." />
                              <CommandList>
                                <CommandEmpty>No account found.</CommandEmpty>
                                <CommandGroup>
                                  {availableCashAccounts.map((account) => (
                                    <CommandItem
                                      key={account.id}
                                      value={account.name}
                                      onSelect={() => {
                                        setSelectedAccountId(account.accountId);
                                        setCashComboboxOpen(false);
                                      }}
                                    >
                                      <Check
                                        className={cn(
                                          "mr-2 h-4 w-4",
                                          selectedAccountId === account.accountId ? "opacity-100" : "opacity-0"
                                        )}
                                      />
                                      {account.name}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </div>
                      <Button
                        onClick={() => {
                          if (selectedAccountId > 0) {
                            const account = allAccounts.find((a) => a.accountId === selectedAccountId);
                            addAccountMutation.mutate({
                              accountType: account?.type.toLowerCase() || "ledger",
                              accountId: selectedAccountId,
                            });
                          }
                        }}
                        disabled={selectedAccountId === 0 || addAccountMutation.isPending}
                        className="w-full"
                        data-testid="button-save-cash-account"
                      >
                        {addAccountMutation.isPending ? "Adding..." : "Add Account"}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>

              {cashAccountsError ? (
                <p className="text-sm text-destructive text-center py-4">Error loading accounts</p>
              ) : displayedCashAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No accounts added yet</p>
              ) : (
                <div className="space-y-1">
                  {displayedCashAccounts.map((dca) => {
                    const balance = parseFloat(String(dca.account.balance || dca.account.currentBalance || 0));
                    return (
                      <div
                        key={dca.id}
                        draggable
                        onDragStart={() => {
                          dragCashRef.current = dca.id;
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => handleCashDrop(dca.id)}
                        className="flex items-center gap-2 py-2 px-2 rounded-sm hover-elevate group cursor-grab active:cursor-grabbing"
                        data-testid={`cash-account-row-${dca.id}`}
                      >
                        <GripVertical className="h-4 w-4 text-muted-foreground/60 shrink-0" />
                        <span className="flex-1 text-sm font-medium truncate">{dca.account.name}</span>
                        <span
                          className="text-sm font-bold font-mono text-chart-2 shrink-0"
                          data-testid={`text-balance-${dca.id}`}
                        >
                          {formatCashAmount(balance)}
                        </span>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="ml-1 opacity-100 md:opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                          onClick={() => removeAccountMutation.mutate(dca.id)}
                          data-testid={`button-remove-cash-account-${dca.id}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between py-2 px-2 bg-chart-2/10 rounded-sm font-semibold mt-1">
                    <span className="text-sm">Total Available</span>
                    <span className="text-sm font-mono text-chart-2">{formatCashAmount(totalAvailable)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* ─── To Pay ─── */}
            <div className="p-4 sm:p-5 border-t lg:border-t-0">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-destructive flex items-center gap-1.5">
                  <ArrowUpRight className="h-4 w-4" />
                  To Pay
                </h3>
                <Dialog open={isAddPayableDialogOpen} onOpenChange={setIsAddPayableDialogOpen}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline" data-testid="button-add-payable-account">
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Account to To Pay</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <label className="text-sm font-medium mb-2 block">Account</label>
                        <Popover open={payableComboboxOpen} onOpenChange={setPayableComboboxOpen}>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              role="combobox"
                              aria-expanded={payableComboboxOpen}
                              className="w-full justify-between"
                              data-testid="select-payable-account"
                            >
                              {selectedPayableAccountId > 0
                                ? availablePayableAccounts.find((acc) => acc.accountId === selectedPayableAccountId)
                                    ?.name || "Select account..."
                                : "Search accounts..."}
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-full p-0" align="start">
                            <Command>
                              <CommandInput placeholder="Search accounts..." />
                              <CommandList>
                                <CommandEmpty>No account found.</CommandEmpty>
                                <CommandGroup>
                                  {availablePayableAccounts.map((account) => (
                                    <CommandItem
                                      key={account.accountId}
                                      value={account.name}
                                      onSelect={() => {
                                        setSelectedPayableAccountId(account.accountId);
                                        setPayableComboboxOpen(false);
                                      }}
                                    >
                                      <Check
                                        className={cn(
                                          "mr-2 h-4 w-4",
                                          selectedPayableAccountId === account.accountId ? "opacity-100" : "opacity-0"
                                        )}
                                      />
                                      {account.name}
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </div>
                      <Button
                        onClick={() => {
                          if (selectedPayableAccountId > 0) {
                            addPayableAccountMutation.mutate({
                              accountId: selectedPayableAccountId,
                            });
                          }
                        }}
                        disabled={selectedPayableAccountId === 0 || addPayableAccountMutation.isPending}
                        className="w-full"
                        data-testid="button-save-payable-account"
                      >
                        {addPayableAccountMutation.isPending ? "Adding..." : "Add Account"}
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>

              {payableAccountsError ? (
                <p className="text-sm text-destructive text-center py-4">Error loading accounts</p>
              ) : dashboardPayableAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No accounts added yet</p>
              ) : (
                <div className="space-y-1">
                  {dashboardPayableAccounts.map((account) => (
                    <div
                      key={account.id}
                      draggable
                      onDragStart={() => {
                        dragPayableRef.current = account.id;
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => handlePayableDrop(account.id)}
                      className="flex items-center gap-2 py-2 px-2 rounded-sm hover-elevate group cursor-grab active:cursor-grabbing"
                      data-testid={`payable-account-row-${account.id}`}
                    >
                      <GripVertical className="h-4 w-4 text-muted-foreground/60 shrink-0" />
                      <span className="flex-1 text-sm font-medium truncate">{account.name}</span>
                      <span
                        className="text-sm font-bold font-mono text-destructive shrink-0"
                        data-testid={`text-payable-${account.id}`}
                      >
                        {formatCashAmount(Math.abs(account.balance))}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-1 opacity-100 md:opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        onClick={() => removePayableAccountMutation.mutate(account.id)}
                        data-testid={`button-remove-payable-account-${account.id}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <div className="flex items-center justify-between py-2 px-2 bg-destructive/10 rounded-sm font-semibold mt-1">
                    <span className="text-sm">Total To Pay</span>
                    <span className="text-sm font-mono text-destructive">{formatCashAmount(totalPayable)}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
