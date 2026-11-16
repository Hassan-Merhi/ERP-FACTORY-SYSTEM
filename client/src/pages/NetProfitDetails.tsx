import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Minus, AlertCircle, TrendingUp, Wallet, Scale } from "lucide-react";
import { SidePanel } from "./netprofitdetails/NetPositionSidePanel";
import { FxHistoryDialog } from "@/components/netposition/FxHistoryDialog";
import {
  NetProfitDetailsPageHeaderSection,
  NetProfitDetailsSection,
  useNetProfitDetailsState,
} from "./useNetProfitDetailsState";

export default function NetProfitDetails() {
  const {
    accountOrder,
    clearDates,
    data,
    displayLayout,
    error,
    formatAmount,
    fromDate,
    fxHistorySide,
    isFiltered,
    isLoading,
    orderActions,
    parseLocalDate,
    refetch,
    selectFrom,
    selectTo,
    selectedCompany,
    sendWhatsApp,
    setFxHistorySide,
    toDate,
  } = useNetProfitDetailsState();

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <Skeleton className="h-8 w-64" />
        </div>
        <Skeleton className="h-32 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span>Failed to load data: {(error as Error).message}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const forUsTotal = data?.forUsTotal || 0;
  const onUsTotal = data?.onUsTotal || 0;
  const netPos = data?.netPosition || 0;
  const isPositive = netPos >= 0;

  // Ratio bar: what fraction of total is assets
  const grandTotal = forUsTotal + onUsTotal;
  const assetPct = grandTotal > 0 ? (forUsTotal / grandTotal) * 100 : 50;
  const nativeCurrencies = Object.keys(data?.currency?.nativeDebitByCurrency ?? {});
  const hasSpPosProfitBaseline = Boolean(data?.spPosProfitBaselineDate);
  const showPartnerEquity = selectedCompany?.companyType === "supplier_partner";

  return (
    <div className="space-y-5 w-full sm:p-4 md:p-6">
      {/* ── Header ── */}
      <NetProfitDetailsPageHeaderSection
        fromDate={fromDate}
        refetch={refetch}
        sendWhatsApp={sendWhatsApp}
        toDate={toDate}
      />

      <NetProfitDetailsSection
        clearDates={clearDates}
        fromDate={fromDate}
        isFiltered={isFiltered}
        parseLocalDate={parseLocalDate}
        selectFrom={selectFrom}
        selectTo={selectTo}
        toDate={toDate}
      />

      {/* Only provisional totals need the warning; resolved historical rates are not news. */}
      {data?.currency?.totalsProvisional && (
        <Card className="border-amber-500/40 bg-amber-500/5" data-testid="net-position-currency-context">
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-sm font-semibold">Currency context</p>
              <Badge variant={data.currency.totalsProvisional ? "outline" : "secondary"}>
                {data.currency.totalsProvisional ? "Provisional" : "Historical rates resolved"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Native balances remain separate; historical base values use the {data.currency.rateConvention} convention.
            </p>
            {nativeCurrencies.length > 0 && (
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs font-mono">
                {nativeCurrencies.map((currency) => (
                  <span key={currency}>
                    {currency} debit {data.currency?.nativeDebitByCurrency[currency]}
                  </span>
                ))}
              </div>
            )}
            {data.currency.totalsProvisional && (
              <p className="text-xs text-amber-800 dark:text-amber-200" role="status">
                {data.currency.unresolvedLegacyEntryCount} legacy foreign-currency entries remain unresolved and are
                excluded from reliable base totals.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Summary hero ── */}
      <Card data-testid="card-formula" className="overflow-hidden">
        <CardContent className="p-0">
          {/* Three stat blocks */}
          <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
            {/* What We Have */}
            <div className="p-5 flex items-center gap-4">
              <div className="p-2.5 rounded-xl bg-emerald-100 dark:bg-emerald-900/50 shrink-0">
                <Wallet className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                  What We Have
                </p>
                <p className="text-2xl font-bold font-mono tabular-nums text-emerald-600 dark:text-emerald-400 truncate">
                  {formatAmount(forUsTotal)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {data?.forUs.accounts?.length || 0} asset accounts
                </p>
              </div>
            </div>

            {/* What We Owe */}
            <div className="p-5 flex items-center gap-4">
              <div className="p-2.5 rounded-xl bg-rose-100 dark:bg-rose-900/50 shrink-0">
                <Scale className="h-5 w-5 text-rose-600 dark:text-rose-400" />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">What We Owe</p>
                <p className="text-2xl font-bold font-mono tabular-nums text-rose-600 dark:text-rose-400 truncate">
                  {formatAmount(onUsTotal)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {data?.onUs.accounts?.length || 0} liability accounts
                </p>
              </div>
            </div>

            {/* Net Position */}
            <div
              className={`p-5 flex items-center gap-4 ${isPositive ? "bg-emerald-50/40 dark:bg-emerald-950/20" : "bg-rose-50/40 dark:bg-rose-950/20"}`}
            >
              <div
                className={`p-2.5 rounded-xl shrink-0 ${isPositive ? "bg-emerald-100 dark:bg-emerald-900/50" : "bg-rose-100 dark:bg-rose-900/50"}`}
              >
                {isPositive ? (
                  <TrendingUp className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Minus className="h-5 w-5 text-rose-600 dark:text-rose-400" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                  Net Position
                </p>
                <p
                  className={`text-2xl font-bold font-mono tabular-nums truncate ${isPositive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
                >
                  {formatAmount(netPos)}
                </p>
                <Badge variant={isPositive ? "default" : "destructive"} className="mt-1 text-xs">
                  {data?.netPositionLabel || "Net Position"}
                </Badge>
              </div>
            </div>
          </div>

          {/* Ratio bar */}
          <div className="px-5 pb-4 pt-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
              <span>Assets {assetPct.toFixed(0)}%</span>
              <span>Liabilities {(100 - assetPct).toFixed(0)}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-rose-200 dark:bg-rose-900/60 overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 dark:bg-emerald-500 transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(0, assetPct))}%` }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Assets + Liabilities side by side ── */}
      {accountOrder.canArrange && (
        <div className="flex flex-wrap items-center justify-end gap-2 mb-2">
          <span className="text-xs text-muted-foreground">
            {accountOrder.arranging ? "Drag grouped accounts or use the arrows. Saved for all users." : ""}
          </span>
          <Button
            size="sm"
            variant={accountOrder.arranging ? "default" : "outline"}
            onClick={() => accountOrder.setArranging(!accountOrder.arranging)}
            disabled={accountOrder.isSaving}
            data-testid="button-arrange-net-position"
          >
            {accountOrder.arranging ? "Finish arranging" : "Arrange groups & accounts"}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        <SidePanel
          id="assets"
          onFxClick={setFxHistorySide}
          title="What We Have"
          subtitle={`${data?.forUs.accounts?.length || 0} asset accounts`}
          side="asset"
          total={forUsTotal}
          accounts={data?.forUs.accounts || []}
          formatAmount={formatAmount}
          displayLayout={displayLayout}
          orderActions={orderActions}
        />
        <SidePanel
          id="liabilities"
          onFxClick={setFxHistorySide}
          title="What We Owe"
          subtitle={`${data?.onUs.accounts?.length || 0} liability accounts`}
          side="liability"
          total={onUsTotal}
          accounts={data?.onUs.accounts || []}
          formatAmount={formatAmount}
          displayLayout={displayLayout}
          orderActions={orderActions}
        />
      </div>

      {fxHistorySide && data && (
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
          scope="erp"
          companyId={selectedCompany?.id}
        />
      )}

      {/* ── Amounts not yet in the ledger (never in the totals) ── */}

      {/* ── Partner capital / equity (Supplier Partner only) ── */}
      {showPartnerEquity && (
        <SidePanel
          id="equity"
          title="Partner Capital / Equity"
          subtitle={`${data?.equity?.accounts?.length || 0} equity accounts — excluded from Net Position totals`}
          side="equity"
          total={data?.equity?.total ?? 0}
          accounts={data?.equity?.accounts || []}
          formatAmount={formatAmount}
        />
      )}

      {/* SP Partner: Realized POS Profit */}
      {((data?.spPosProfit ?? 0) !== 0 || hasSpPosProfitBaseline) && (
        <Card data-testid="card-sp-pos-profit" className="overflow-hidden">
          <div className="bg-linear-to-r from-blue-500/10 to-transparent dark:from-blue-500/15 px-5 py-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400">
                  <TrendingUp className="h-4 w-4" />
                </div>
                <div>
                  <div className="font-semibold text-base text-blue-600 dark:text-blue-400">
                    Realized Profit (POS Sales)
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Supplier partner POS profit —{" "}
                    {hasSpPosProfitBaseline
                      ? `monthly profit from ${data?.spPosProfitPeriodStartDate || data?.spPosProfitBaselineDate}`
                      : `monthly profit from ${data?.spPosProfitPeriodStartDate || "the first of this month"}`}
                  </div>
                </div>
              </div>
              <span
                className={`text-2xl font-bold font-mono tabular-nums ${(data?.spPosProfit ?? 0) >= 0 ? "text-blue-600 dark:text-blue-400" : "text-destructive"}`}
              >
                {formatAmount(data?.spPosProfit ?? 0)}
              </span>
            </div>
          </div>
          <CardContent className="pt-3 pb-4">
            <div className="rounded-md overflow-hidden border border-border/60">
              <div className="flex items-center justify-between px-3 py-2.5 text-sm">
                <span className="text-foreground">Supplier Partner POS Profit</span>
                <span className="font-mono tabular-nums font-medium text-blue-600 dark:text-blue-400">
                  {formatAmount(data?.spPosProfit ?? 0)}
                </span>
              </div>
              <div className="px-3 py-2 bg-muted/40 text-xs text-muted-foreground border-t border-border/50">
                Formula: Sum of (sale price − cost price) for sales in this month
                {data?.spPosProfitPeriodStartDate
                  ? ` (${data.spPosProfitPeriodStartDate} to ${data.spPosProfitAsOfDate || "today"})`
                  : ""}
                . Prior months remain available through the date filter.
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
