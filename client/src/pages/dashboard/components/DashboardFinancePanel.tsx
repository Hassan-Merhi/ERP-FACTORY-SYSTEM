import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ArrowDownLeft, ArrowUpRight, ChevronRight, Wallet } from "lucide-react";
import { useDashboardFinancePanelState, type DashboardFinancePanelProps } from "./useDashboardFinancePanelState";
import { DashboardFinancePanelSection } from "./DashboardFinancePanelSection";

export function DashboardFinancePanel(props: DashboardFinancePanelProps) {
  const {
    addAccountMutation,
    addPayableAccountMutation,
    allAccounts,
    appMode,
    availableCashAccounts,
    availablePayableAccounts,
    cashAccountsError,
    cashComboboxOpen,
    dashboardPayableAccounts,
    displayedCashAccounts,
    dragCashRef,
    dragPayableRef,
    formatAmount,
    formatCashAmount,
    handleCashDrop,
    handlePayableDrop,
    isAddDialogOpen,
    isAddPayableDialogOpen,
    isFactoryMode,
    isLoading,
    isViewer,
    modePrefix,
    netCashPosition,
    payableAccountsError,
    payableComboboxOpen,
    profitData,
    removeAccountMutation,
    removePayableAccountMutation,
    selectedAccountId,
    selectedPayableAccountId,
    setCashComboboxOpen,
    setIsAddDialogOpen,
    setIsAddPayableDialogOpen,
    setLocation,
    setPayableComboboxOpen,
    setSelectedAccountId,
    setSelectedPayableAccountId,
    totalAvailable,
    totalPayable,
  } = useDashboardFinancePanelState(props);

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
          <DashboardFinancePanelSection
            addAccountMutation={addAccountMutation}
            addPayableAccountMutation={addPayableAccountMutation}
            allAccounts={allAccounts}
            availableCashAccounts={availableCashAccounts}
            availablePayableAccounts={availablePayableAccounts}
            cashAccountsError={cashAccountsError}
            cashComboboxOpen={cashComboboxOpen}
            dashboardPayableAccounts={dashboardPayableAccounts}
            displayedCashAccounts={displayedCashAccounts}
            dragCashRef={dragCashRef}
            dragPayableRef={dragPayableRef}
            formatCashAmount={formatCashAmount}
            handleCashDrop={handleCashDrop}
            handlePayableDrop={handlePayableDrop}
            isAddDialogOpen={isAddDialogOpen}
            isAddPayableDialogOpen={isAddPayableDialogOpen}
            isViewer={isViewer}
            payableAccountsError={payableAccountsError}
            payableComboboxOpen={payableComboboxOpen}
            removeAccountMutation={removeAccountMutation}
            removePayableAccountMutation={removePayableAccountMutation}
            selectedAccountId={selectedAccountId}
            selectedPayableAccountId={selectedPayableAccountId}
            setCashComboboxOpen={setCashComboboxOpen}
            setIsAddDialogOpen={setIsAddDialogOpen}
            setIsAddPayableDialogOpen={setIsAddPayableDialogOpen}
            setPayableComboboxOpen={setPayableComboboxOpen}
            setSelectedAccountId={setSelectedAccountId}
            setSelectedPayableAccountId={setSelectedPayableAccountId}
            totalAvailable={totalAvailable}
            totalPayable={totalPayable}
          />
        </Card>
      )}
    </div>
  );
}
