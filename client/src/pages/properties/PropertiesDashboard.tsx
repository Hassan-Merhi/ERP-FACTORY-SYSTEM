import { KPICard } from "@/components/KPICard";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { TrendingUp, Wallet, ArrowUpRight, ArrowDownLeft, Truck, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import { CustomNetPositionView } from "./propertiesdashboard/components/CustomNetPositionView";
import { usePropertiesDashboardState } from "./usePropertiesDashboardState";
import { PropertiesDashboardSection } from "./PropertiesDashboardSection";

export default function PropertiesDashboard() {
  const {
    addAccountMutation,
    addPayableAccountMutation,
    allAccounts,
    availableCashAccounts,
    availablePayableAccounts,
    canConfigureDashboard,
    cashAccountsError,
    cashComboboxOpen,
    dashboardPayableAccounts,
    displayedCashAccounts,
    dragCashRef,
    dragPayableRef,
    formatAmount,
    handleCashDrop,
    handlePayableDrop,
    importCycleData,
    isAddDialogOpen,
    isAddPayableDialogOpen,
    isError,
    isLoading,
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
    setPayableComboboxOpen,
    setSelectedAccountId,
    setSelectedPayableAccountId,
  } = usePropertiesDashboardState();

  if (isError) {
    return (
      <div className="space-y-6">
        <div className="text-destructive">Failed to load dashboard data. Please try again.</div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <PageHeader title="Dashboard" subtitle="Overview of your properties performance" showHomeButton={false} />
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <KPICard
          title="Total Income"
          value={isLoading ? "Loading..." : formatAmount(profitData?.totalIncome || 0)}
          change="From all income accounts"
          changeType="positive"
          icon={DollarSign}
          data-testid="kpi-total-income"
        />
        <KPICard
          title="Net Position"
          value={isLoading ? "Loading..." : formatAmount(profitData?.netPosition || 0)}
          change={profitData?.netPositionLabel || "What we have minus what we owe"}
          changeType={(profitData?.netPosition ?? 0) >= 0 ? "positive" : "negative"}
          icon={TrendingUp}
          data-testid="kpi-net-position"
        />
        <KPICard
          title="Import Cycle Balance"
          value={
            !importCycleData
              ? "Loading..."
              : Math.abs(importCycleData.netImportCycleBalance) < 1
                ? formatAmount(0)
                : formatAmount(importCycleData.netImportCycleBalance)
          }
          change="Should be $0 when balanced"
          changeType={Math.abs(importCycleData?.netImportCycleBalance ?? 0) < 1 ? "positive" : "negative"}
          icon={Truck}
          data-testid="kpi-import-cycle-balance"
        />
      </div>

      {/* Net Position Breakdown */}
      <Card className="p-4 sm:p-6">
        <div className="mb-4">
          <h3 className="text-lg font-medium">Net Position Breakdown</h3>
        </div>
        {isLoading ? (
          <div className="flex items-center justify-center h-[200px]">
            <p className="text-muted-foreground">Loading...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6">
            {/* What We Have (Assets) */}
            <div className="border rounded-lg p-4">
              <h4 className="font-medium text-green-600 mb-3 flex items-center gap-2">
                <ArrowDownLeft className="h-4 w-4" />
                What We Have
              </h4>
              <div className="space-y-2 text-sm">
                {(profitData?.forUsBreakdown ?? []).map((item, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span className="text-muted-foreground">{item.name}:</span>
                    <span className="font-mono">{formatAmount(item.value)}</span>
                  </div>
                ))}
                <div className="border-t pt-2 mt-2 flex justify-between font-medium">
                  <span>Total Assets:</span>
                  <span className="font-mono text-green-600">{formatAmount(profitData?.forUsTotal ?? 0)}</span>
                </div>
              </div>
            </div>

            {/* What We Owe (Liabilities) */}
            <div className="border rounded-lg p-4">
              <h4 className="font-medium text-red-600 mb-3 flex items-center gap-2">
                <ArrowUpRight className="h-4 w-4" />
                What We Owe
              </h4>
              <div className="space-y-2 text-sm">
                {(profitData?.onUsBreakdown ?? []).map((item, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span className="text-muted-foreground">{item.name}:</span>
                    <span className="font-mono text-red-600">{formatAmount(item.value)}</span>
                  </div>
                ))}
                <div className="border-t pt-2 mt-2 flex justify-between font-medium">
                  <span>Total Liabilities:</span>
                  <span className="font-mono text-red-600">{formatAmount(profitData?.onUsTotal ?? 0)}</span>
                </div>
              </div>
            </div>

            {/* What We Spent (Expenses) */}
            <div className="border rounded-lg p-4">
              <h4 className="font-medium text-orange-600 mb-3 flex items-center gap-2">
                <Wallet className="h-4 w-4" />
                What We Spent
              </h4>
              <div className="space-y-2 text-sm">
                {(profitData?.expenses?.breakdown ?? []).map((item, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span className="text-muted-foreground">{item.name}:</span>
                    <span className="font-mono text-orange-600">{formatAmount(item.value)}</span>
                  </div>
                ))}
                <div className="border-t pt-2 mt-2 flex justify-between font-medium">
                  <span>Total Expenses:</span>
                  <span className="font-mono text-orange-600">{formatAmount(profitData?.expensesTotal ?? 0)}</span>
                </div>
              </div>
            </div>

            {/* Net Position Calculation */}
            <div className="border rounded-lg p-4 bg-muted/30">
              <h4 className="font-medium mb-3">Net Position</h4>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Assets:</span>
                  <span className="font-mono text-green-600">{formatAmount(profitData?.forUsTotal ?? 0)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">- Liabilities:</span>
                  <span className="font-mono text-red-600">{formatAmount(profitData?.onUsTotal ?? 0)}</span>
                </div>
                <div className="border-t pt-2 mt-2 flex justify-between font-medium text-lg">
                  <span>=</span>
                  <span
                    className={cn("font-mono", (profitData?.netPosition ?? 0) >= 0 ? "text-green-600" : "text-red-600")}
                  >
                    {formatAmount(profitData?.netPosition ?? 0)}
                  </span>
                </div>
                <div className="text-center mt-2">
                  <span
                    className={cn(
                      "text-xs font-medium px-2 py-1 rounded-full",
                      (profitData?.netPosition ?? 0) >= 0
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    )}
                  >
                    {profitData?.netPositionLabel ?? ""}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Custom Net Position View */}
      {profitData && <CustomNetPositionView data={profitData} />}

      {/* Liquidity Management — Available & To Pay */}
      <Card className="p-0 overflow-hidden">
        {/* KPI summary bar */}
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-x border-b">
          <div className="p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Available</p>
            <p className="text-xl font-bold font-mono text-green-600" data-testid="text-total-available">
              {formatAmount(
                displayedCashAccounts.reduce(
                  (s, d) => s + parseFloat(String(d.account.balance || d.account.currentBalance || 0)),
                  0
                )
              )}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">To Pay</p>
            <p className="text-xl font-bold font-mono text-red-600" data-testid="text-total-payable">
              {formatAmount(dashboardPayableAccounts.reduce((s, a) => s + Math.abs(a.balance), 0))}
            </p>
          </div>
          <div className="p-4 text-center">
            <p className="text-xs text-muted-foreground mb-1">Net</p>
            {(() => {
              const avail = displayedCashAccounts.reduce(
                (s, d) => s + parseFloat(String(d.account.balance || d.account.currentBalance || 0)),
                0
              );
              const pay = dashboardPayableAccounts.reduce((s, a) => s + Math.abs(a.balance), 0);
              const net = avail - pay;
              return (
                <p
                  className={`text-xl font-bold font-mono ${net >= 0 ? "text-green-600" : "text-red-600"}`}
                  data-testid="text-net-position"
                >
                  {formatAmount(net)}
                </p>
              );
            })()}
          </div>
        </div>

        <PropertiesDashboardSection
          addAccountMutation={addAccountMutation}
          addPayableAccountMutation={addPayableAccountMutation}
          allAccounts={allAccounts}
          availableCashAccounts={availableCashAccounts}
          availablePayableAccounts={availablePayableAccounts}
          canConfigureDashboard={canConfigureDashboard}
          cashAccountsError={cashAccountsError}
          cashComboboxOpen={cashComboboxOpen}
          dashboardPayableAccounts={dashboardPayableAccounts}
          displayedCashAccounts={displayedCashAccounts}
          dragCashRef={dragCashRef}
          dragPayableRef={dragPayableRef}
          formatAmount={formatAmount}
          handleCashDrop={handleCashDrop}
          handlePayableDrop={handlePayableDrop}
          isAddDialogOpen={isAddDialogOpen}
          isAddPayableDialogOpen={isAddPayableDialogOpen}
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
        />
      </Card>
    </div>
  );
}
