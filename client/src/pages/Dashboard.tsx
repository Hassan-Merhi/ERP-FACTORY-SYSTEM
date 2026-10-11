import { CountryActivityKPI } from "@/components/CountryActivityKPI";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ErrorState } from "@/components/ui/page-state";
import {
  ArrowDownLeft,
  BarChart2,
  BookOpen,
  Boxes,
  CheckCircle2,
  ChevronDown,
  DollarSign,
  Factory,
  ReceiptText,
  Scale,
  TrendingUp,
  Truck,
  X,
  Zap,
} from "lucide-react";

import { DashboardFinancePanel } from "./dashboard/components/DashboardFinancePanel";
import { DashboardKPICard } from "./dashboard/components/DashboardKPICard";
import { FactoryProductionPanel } from "./dashboard/components/FactoryProductionPanel";
import { useDashboard } from "./dashboard/useDashboard";
import { getGreeting } from "./dashboard/utils";

export default function Dashboard() {
  const dashboard = useDashboard();
  const {
    selectedCompany,
    formatAmount,
    appMode,
    modePrefix,
    setLocation,
    isFactoryMode,
    importCycleExpanded,
    setImportCycleExpanded,
    profitData,
    isLoading,
    isError,
    refetchProfit,
    importCycleData,
    importCycleIsError,
    importCycleIsLoading,
    importCycleBalance,
    isImportCycleBalanced,
  } = dashboard;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* ── Page header ── */}
      <PageHeader
        title={isFactoryMode ? "Factory Dashboard" : "Dashboard"}
        subtitle={isFactoryMode ? "Today's factory floor overview" : "Business performance at a glance"}
        showHomeButton={false}
      />

      {/* ── Net-profit error banner (non-fatal) ── */}
      {isError && (
        <ErrorState
          title="Some financial data is unavailable"
          description="Figures may be incomplete. Retry the financial summary without losing the rest of the dashboard."
          actionLabel="Retry financial data"
          onAction={() => void refetchProfit()}
          className="border-destructive/30"
        />
      )}

      {/* ── Greeting banner ── */}
      <div className="flex flex-wrap items-center justify-between gap-2 -mt-2 px-0.5">
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{getGreeting()}</span>
          {selectedCompany?.name ? ` · ${selectedCompany.name}` : ""}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {new Date().toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            year: "numeric",
          })}
        </p>
      </div>

      {/* ── Quick Actions dropdown ── */}
      <div className="flex gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" data-testid="button-quick-actions">
              <Zap className="h-3.5 w-3.5 mr-1.5" />
              Quick Actions
              <ChevronDown className="h-3.5 w-3.5 ml-1.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {!isFactoryMode ? (
              <>
                <DropdownMenuItem
                  onClick={() => setLocation("/vouchers?type=payment")}
                  data-testid="quick-action-payment"
                >
                  <ReceiptText className="h-4 w-4 mr-2" />
                  New Payment
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setLocation("/vouchers?type=receipt")}
                  data-testid="quick-action-receipt"
                >
                  <ArrowDownLeft className="h-4 w-4 mr-2" />
                  New Receipt
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setLocation("/vouchers?type=journal")}
                  data-testid="quick-action-journal"
                >
                  <BookOpen className="h-4 w-4 mr-2" />
                  New Journal
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setLocation("/sales-report")} data-testid="quick-action-reports">
                  <BarChart2 className="h-4 w-4 mr-2" />
                  Sales Report
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setLocation("/location-inventory")}
                  data-testid="quick-action-inventory"
                >
                  <Boxes className="h-4 w-4 mr-2" />
                  Inventory
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem
                  onClick={() => setLocation("/factory/press-bale")}
                  data-testid="quick-action-press-bale"
                >
                  <Factory className="h-4 w-4 mr-2" />
                  Press Bale
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setLocation("/factory/stock-adjustment")}
                  data-testid="quick-action-stock-adj"
                >
                  <Scale className="h-4 w-4 mr-2" />
                  Stock Adjustment
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setLocation("/factory/location-inventory")}
                  data-testid="quick-action-factory-inventory"
                >
                  <Boxes className="h-4 w-4 mr-2" />
                  Inventory
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* ── Top KPI row ── */}
      <div
        className={cn(
          "grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4",
          !isFactoryMode ? "lg:grid-cols-3" : "lg:grid-cols-2"
        )}
      >
        {!isFactoryMode && (
          <DashboardKPICard
            title="Total Income"
            value={isLoading ? "Loading..." : formatAmount(profitData?.totalIncome || 0)}
            change="All income accounts combined"
            changeType="positive"
            icon={DollarSign}
            stripeClass="bg-linear-to-r from-chart-2 via-chart-2/60 to-chart-2/20"
            iconBgClass="bg-chart-2/15"
            iconFgClass="text-chart-2"
            onClick={() => setLocation("/sales-report")}
            testId="kpi-total-income"
          />
        )}
        <DashboardKPICard
          title="Net Position"
          value={isLoading ? "Loading..." : formatAmount(profitData?.netPosition || 0)}
          change={profitData?.netPositionLabel || "What we have minus what we owe"}
          changeType={(profitData?.netPosition ?? 0) >= 0 ? "positive" : "negative"}
          icon={TrendingUp}
          stripeClass={
            (profitData?.netPosition ?? 0) >= 0
              ? "bg-linear-to-r from-chart-2 via-chart-2/60 to-chart-2/20"
              : "bg-linear-to-r from-destructive via-destructive/60 to-destructive/20"
          }
          iconBgClass={(profitData?.netPosition ?? 0) >= 0 ? "bg-chart-2/15" : "bg-destructive/15"}
          iconFgClass={(profitData?.netPosition ?? 0) >= 0 ? "text-chart-2" : "text-destructive"}
          onClick={() =>
            setLocation(
              modePrefix === ""
                ? "/net-position-details"
                : appMode === "properties"
                  ? "/properties/net-position-details"
                  : `${modePrefix}/net-position`
            )
          }
          testId="kpi-net-position"
        />
        <DashboardKPICard
          title="Import Cycle Balance"
          value={
            importCycleIsError
              ? "Unavailable"
              : importCycleIsLoading
                ? "Loading..."
                : isImportCycleBalanced
                  ? "Balanced"
                  : formatAmount(Math.abs(importCycleBalance!))
          }
          change={
            importCycleIsError
              ? "Could not load cycle data"
              : importCycleIsLoading
                ? ""
                : isImportCycleBalanced
                  ? "All accounts net to zero"
                  : "Should be $0 when balanced"
          }
          changeType={importCycleIsError ? "neutral" : isImportCycleBalanced ? "positive" : "negative"}
          icon={importCycleIsError ? Truck : isImportCycleBalanced ? CheckCircle2 : Truck}
          stripeClass={
            isImportCycleBalanced
              ? "bg-linear-to-r from-chart-2 via-chart-2/60 to-chart-2/20"
              : importCycleIsError
                ? "bg-muted"
                : "bg-linear-to-r from-destructive via-destructive/60 to-destructive/20"
          }
          iconBgClass={isImportCycleBalanced ? "bg-chart-2/15" : importCycleIsError ? "bg-muted" : "bg-destructive/15"}
          iconFgClass={
            isImportCycleBalanced ? "text-chart-2" : importCycleIsError ? "text-muted-foreground" : "text-destructive"
          }
          onClick={
            !importCycleIsError && !isImportCycleBalanced && !importCycleIsLoading
              ? () => setImportCycleExpanded((v) => !v)
              : undefined
          }
          testId="kpi-import-cycle-balance"
        />
      </div>

      {/* ── Import Cycle Breakdown (expandable, only when imbalanced) ── */}
      {!isImportCycleBalanced && importCycleData && importCycleExpanded && (
        <Card className="p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold">Import Cycle Breakdown</h3>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setImportCycleExpanded(false)}
              data-testid="button-close-cycle-breakdown"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            {[
              {
                label: "Supplier Balance",
                value: importCycleData.components.supplierBalance,
              },
              {
                label: "Stock on the Way",
                value: importCycleData.components.stockOtwValue,
              },
              {
                label: "Duty Agent",
                value: importCycleData.components.dutyAgentBalance,
              },
              {
                label: "Transporter Agent",
                value: importCycleData.components.transporterAgentBalance,
              },
              {
                label: "Loans",
                value: importCycleData.components.loansBalance,
              },
              { label: "Cash", value: importCycleData.components.cashBalance },
              { label: "Bank", value: importCycleData.components.bankBalance },
              {
                label: "Direct Expenses",
                value: importCycleData.components.directExpenseBalance,
              },
              {
                label: "Indirect Expenses",
                value: importCycleData.components.indirectExpenseBalance,
              },
              {
                label: "Income",
                value: importCycleData.components.incomeBalance,
              },
              {
                label: "Stock on Floor",
                value: importCycleData.components.stockOnFloorValue,
              },
              { label: "COGS", value: importCycleData.components.cogsBalance },
              {
                label: "Payroll Expense",
                value: importCycleData.components.payrollExpenseBalance,
              },
              {
                label: "Salary Advances",
                value: importCycleData.components.salaryAdvancesBalance,
              },
              {
                label: "Payroll Liabilities",
                value: importCycleData.components.payrollLiabilitiesBalance,
              },
            ].map(({ label, value }) => (
              <div key={label} className="flex justify-between py-1 border-b last:border-0">
                <span className="text-muted-foreground">{label}</span>
                <span
                  className={cn(
                    "font-mono font-medium",
                    value === 0 ? "text-muted-foreground" : value > 0 ? "text-chart-2" : "text-destructive"
                  )}
                >
                  {formatAmount(value)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-3 border-t flex justify-between font-semibold">
            <span>Net Imbalance</span>
            <span className="font-mono text-destructive">{formatAmount(importCycleData.netImportCycleBalance)}</span>
          </div>
        </Card>
      )}

      {/* ── Country Activity KPI (expandable) ── */}
      {!isFactoryMode && <CountryActivityKPI />}

      {/* ── Main content area: 2-col on XL ── */}
      <DashboardFinancePanel dashboard={dashboard} />

      <FactoryProductionPanel dashboard={dashboard} />
    </div>
  );
}
