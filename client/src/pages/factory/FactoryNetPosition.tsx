import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, Equal, AlertCircle, CalendarDays } from "lucide-react";
import { fmt, formatDateLabel } from "./factorynetposition/utils";
import { NotInLedgerCard } from "@/components/netposition/NotInLedgerCard";
import { Side } from "./factorynetposition/components/Side";
import { CustomNetPositionView } from "./factorynetposition/components/CustomNetPositionView";
import { FxHistoryDialog } from "@/components/netposition/FxHistoryDialog";
import {
  FactoryNetPositionCardNetPosition,
  FactoryNetPositionCardUpcomingReceivables,
  FactoryNetPositionSection,
  useFactoryNetPositionState,
} from "./FactoryNetPositionSection";
import { FactoryNetPositionCard } from "./FactoryNetPositionCard";

export default function FactoryNetPosition() {
  const {
    asOf,
    companyToday,
    data,
    displayAsOf,
    error,
    fxHistorySide,
    hasPendingVerified,
    isFetching,
    isLoading,
    isPositive,
    isSavingValuationMode,
    isToday,
    refetch,
    setAsOf,
    setFxHistorySide,
    updatePref,
    valuationMode,
  } = useFactoryNetPositionState();

  if (error) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <p>
            {isToday
              ? "Failed to load net position data."
              : `The snapshot for ${formatDateLabel(asOf)} could not be built. No current balance was substituted.`}
          </p>
        </div>
        {!isToday && (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => setAsOf("")}
            data-testid="button-error-back-today"
          >
            Back to today
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <FactoryNetPositionSection
        companyToday={companyToday}
        data={data}
        displayAsOf={displayAsOf}
        isFetching={isFetching}
        isSavingValuationMode={isSavingValuationMode}
        isToday={isToday}
        refetch={refetch}
        setAsOf={setAsOf}
        updatePref={updatePref}
        valuationMode={valuationMode}
      />

      <div className="text-xs text-muted-foreground -mt-4" data-testid="text-inventory-valuation-mode">
        Stock in Hand valued at {valuationMode === "selling" ? "Selling" : "Cost"} · Balance on Table stays at Cost
      </div>

      {/* Historical mode banner */}
      {!isToday && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-sm">
          <CalendarDays className="h-4 w-4 shrink-0" />
          <div>
            Showing net position as of <strong>{formatDateLabel(displayAsOf)}</strong>.{" "}
            {data?.historyWarnings?.[0] || "Historical reconstruction is in progress; current-state values may remain."}
            {!!data?.historyWarnings?.slice(1).length && (
              <details className="mt-1">
                <summary className="cursor-pointer">
                  Historical data limitations ({data.historyWarnings.length - 1})
                </summary>
                <ul className="list-disc pl-5 mt-1 space-y-1">
                  {data.historyWarnings.slice(1).map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      )}

      {!!data?.fxAgentWalletWarnings?.length && (
        <div role="alert" className="rounded-md border border-amber-300 p-3 text-sm text-amber-700 dark:text-amber-300">
          <p className="font-semibold">FX Agent Account Reconciliation Warnings</p>
          {data.fxAgentWalletWarnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </div>
      )}

      {/* Net Position Banner */}
      {isLoading ? (
        <Skeleton className="h-28 w-full rounded-md" />
      ) : (
        <FactoryNetPositionCardNetPosition data={data} isPositive={isPositive} />
      )}

      {/* What We Have | What We Owe grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Side
            label="What We Have"
            sublabel="Assets and unrealized FX gains — cash, stock, receivables and orders"
            total={data?.forUs.total ?? 0}
            breakdown={data?.forUs.breakdown ?? []}
            accounts={data?.forUs.accounts ?? []}
            colorClass="text-green-600 dark:text-green-400"
            onFxClick={setFxHistorySide}
            icon={<TrendingUp className="h-5 w-5 text-green-600 dark:text-green-400" />}
          />
          <Side
            label="What We Owe"
            sublabel="Liabilities and unrealized FX losses — suppliers, loans and other payables"
            total={data?.onUs.total ?? 0}
            breakdown={data?.onUs.breakdown ?? []}
            accounts={data?.onUs.accounts ?? []}
            colorClass="text-red-600 dark:text-red-400"
            onFxClick={setFxHistorySide}
            icon={<TrendingDown className="h-5 w-5 text-red-600 dark:text-red-400" />}
          />
        </div>
      )}

      {data && fxHistorySide && (
        <FxHistoryDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) setFxHistorySide(null);
          }}
          side={fxHistorySide}
          amount={
            (fxHistorySide === "gain" ? data.forUs.accounts : data.onUs.accounts).find(
              (a) => a.code === (fxHistorySide === "gain" ? "FX_UNREALIZED_GAIN" : "FX_UNREALIZED_LOSS")
            )?.value ?? 0
          }
          sources={
            (fxHistorySide === "gain" ? data.forUs.accounts : data.onUs.accounts).find(
              (a) => a.code === (fxHistorySide === "gain" ? "FX_UNREALIZED_GAIN" : "FX_UNREALIZED_LOSS")
            )?.breakdown
          }
          scope="factory"
          companyId={data.companyId}
          asOf={displayAsOf}
        />
      )}

      {/* Amounts not yet in the ledger — shown separately, never in the totals */}
      {!isLoading && <NotInLedgerCard section={data?.notInLedger} formatAmount={fmt} />}

      {/* Custom Net Position View — view-only, user-configurable account visibility */}
      {!isLoading && data && (
        <CustomNetPositionView key={data.companyId ?? "no-company"} data={data} onFxClick={setFxHistorySide} />
      )}

      {/* Broker Balance Breakdown */}
      {!isLoading && (data?.onUs.accounts ?? []).some((a) => a.code === "SUPPLIER" && a.breakdown?.length) && (
        <FactoryNetPositionCard data={data} />
      )}

      {/* Upcoming Receivables — Pending, Verified & Loading Orders */}
      {isLoading ? (
        <Skeleton className="h-48 w-full rounded-md" />
      ) : (
        <FactoryNetPositionCardUpcomingReceivables data={data} hasPendingVerified={hasPendingVerified} />
      )}

      {/* Sub-totals info */}
      {!isLoading &&
        data &&
        (data.supplierLiabilities > 0 ||
          data.ledgerAssets > 0 ||
          data.inventoryValue > 0 ||
          data.rawMaterialValue > 0) && (
          <Card data-testid="card-composition">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Equal className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Composition</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 text-sm">
                {data.inventoryValue > 0 && (
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs uppercase tracking-wide">Stock In Hand</p>
                    <p
                      className="font-mono font-semibold text-green-600 dark:text-green-400"
                      data-testid="text-inventory-value"
                    >
                      {fmt(data.inventoryValue)}
                    </p>
                    <p className="text-xs text-muted-foreground">Location inventory sell value</p>
                  </div>
                )}
                {data.rawMaterialValue > 0 && (
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs uppercase tracking-wide">Raw Material Stock</p>
                    <p
                      className="font-mono font-semibold text-green-600 dark:text-green-400"
                      data-testid="text-raw-material-value"
                    >
                      {fmt(data.rawMaterialValue)}
                    </p>
                    <p className="text-xs text-muted-foreground">Raw materials stock value</p>
                  </div>
                )}
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Ledger Assets</p>
                  <p className="font-mono font-semibold text-green-600 dark:text-green-400">{fmt(data.ledgerAssets)}</p>
                  <p className="text-xs text-muted-foreground">From accounting records</p>
                </div>
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Supplier Balances</p>
                  <p className="font-mono font-semibold text-red-600 dark:text-red-400">
                    {fmt(data.supplierLiabilities)}
                  </p>
                  <p className="text-xs text-muted-foreground">Raw material suppliers owed</p>
                </div>
                {(data.supplierOverpayments ?? 0) > 0 && (
                  <div className="space-y-1">
                    <p className="text-muted-foreground text-xs uppercase tracking-wide">Supplier Overpayments</p>
                    <p className="font-mono font-semibold text-green-600 dark:text-green-400">
                      {fmt(data.supplierOverpayments ?? 0)}
                    </p>
                    <p className="text-xs text-muted-foreground">Overpaid — recoverable from suppliers</p>
                  </div>
                )}
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs uppercase tracking-wide">Other Liabilities</p>
                  <p className="font-mono font-semibold text-red-600 dark:text-red-400">
                    {fmt(data.ledgerLiabilities)}
                  </p>
                  <p className="text-xs text-muted-foreground">From accounting records</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
    </div>
  );
}
