import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Minus, Equal, AlertCircle } from "lucide-react";
import { CustomNetPositionView } from "./factorynetposition/components/DetailsCustomNetPositionView";
import { FxHistoryDialog } from "@/components/netposition/FxHistoryDialog";
import { CollapsibleSection } from "./FactoryNetPositionDetailsCollapsibleSection";
import { useFactoryNetPositionDetailsState } from "./useFactoryNetPositionDetailsState";
import { FactoryNetPositionDetailsContent } from "./FactoryNetPositionDetailsContent";

export default function FactoryNetPositionDetails() {
  const {
    formatAmount,
    accountOrder,
    displayLayout,
    orderActions,
    asOf,
    setAsOf,
    setFxHistorySide,
    fxHistorySide,
    queryClient,
    isToday,
    isSavingValuationMode,
    updatePref,
    valuationMode,
    isLoading,
    error,
    refetch,
    data,
    isFetching,
    displayAsOf,
    companyToday,
  } = useFactoryNetPositionDetailsState();

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    const errAny = error as unknown as { code: unknown };
    const isEndpointBusy = errAny?.code === "ENDPOINT_BUSY";
    const friendlyMessage = isEndpointBusy
      ? "The report is already being generated. It will retry automatically in a few seconds…"
      : (() => {
          try {
            const parsed = JSON.parse((error as Error).message);
            return parsed?.message ?? (error as Error).message;
          } catch {
            return (error as Error).message;
          }
        })();

    return (
      <div className="p-6">
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span>{friendlyMessage}</span>
            </div>
            {!isEndpointBusy && (
              <button className="mt-3 text-sm underline text-muted-foreground" onClick={() => refetch()}>
                Try again
              </button>
            )}
            {asOf && (
              <button
                className="mt-3 ml-4 text-sm underline text-muted-foreground"
                onClick={() => setAsOf("")}
                data-testid="button-error-back-today"
              >
                Back to today
              </button>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const net = data?.netPosition ?? 0;
  const isPositive = net >= 0;

  return (
    <div className="p-4 md:p-6 space-y-4 w-full">
      <FactoryNetPositionDetailsContent
        companyToday={companyToday}
        displayAsOf={displayAsOf}
        isFetching={isFetching}
        isSavingValuationMode={isSavingValuationMode}
        isToday={isToday}
        queryClient={queryClient}
        refetch={refetch}
        setAsOf={setAsOf}
        updatePref={updatePref}
        valuationMode={valuationMode}
      />

      {data?.historyCompleteness === "partial" && (
        <div role="status" className="text-sm text-amber-700 dark:text-amber-300" data-testid="historical-data-warning">
          <p>
            {data.historyWarnings?.[0] ||
              "Historical reconstruction is incomplete; some values may still reflect current state."}
          </p>
          {!!data.historyWarnings?.slice(1).length && (
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
      )}
      <div className="text-xs text-muted-foreground -mt-2" data-testid="text-inventory-valuation-mode">
        Stock in Hand valued at {valuationMode === "selling" ? "Selling" : "Cost"} · Balance on Table stays at Cost
      </div>

      <Card data-testid="card-formula">
        <CardContent className="pt-5">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 bg-green-50 dark:bg-green-950/40 px-4 py-2.5 rounded-md">
              <span className="text-sm font-medium text-green-700 dark:text-green-300">What We Have</span>
              <span className="shrink-0 whitespace-nowrap font-bold font-mono text-green-600">
                {formatAmount(data?.forUsTotal || 0)}
              </span>
            </div>
            <Minus className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-2 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 rounded-md">
              <span className="text-sm font-medium text-red-700 dark:text-red-300">What We Owe</span>
              <span className="shrink-0 whitespace-nowrap font-bold font-mono text-red-600">
                {formatAmount(data?.onUsTotal || 0)}
              </span>
            </div>
            <Equal className="h-4 w-4 text-muted-foreground shrink-0" />
            <div
              className={`flex items-center gap-2 px-4 py-2.5 rounded-md ${isPositive ? "bg-green-100 dark:bg-green-900/40" : "bg-red-100 dark:bg-red-900/40"}`}
            >
              <span
                className={`text-sm font-medium ${isPositive ? "text-green-700 dark:text-green-300" : "text-red-700 dark:text-red-300"}`}
              >
                Net Position
              </span>
              <span
                className={`shrink-0 whitespace-nowrap font-bold font-mono ${isPositive ? "text-green-600" : "text-red-600"}`}
              >
                {formatAmount(net)}
              </span>
            </div>
            <Badge variant={isPositive ? "default" : "destructive"} className="ml-auto sm:ml-2">
              {data?.netPositionLabel || "Net Position"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        {accountOrder.canArrange && (
          <div className="col-span-full flex items-center justify-end gap-2 flex-wrap">
            {accountOrder.arranging && (
              <span className="text-xs text-muted-foreground">
                Drag groups/accounts or use arrows. Saved for everyone.
              </span>
            )}
            <Button
              size="sm"
              variant={accountOrder.arranging ? "default" : "outline"}
              disabled={accountOrder.isSaving}
              onClick={() => accountOrder.setArranging(!accountOrder.arranging)}
              data-testid="button-arrange-factory-net-position"
            >
              {accountOrder.arranging ? "Finish arranging" : "Arrange groups & accounts"}
            </Button>
          </div>
        )}
        <CollapsibleSection
          id="assets"
          onFxClick={setFxHistorySide}
          title="What We Have"
          subtitle={`${data?.forUs.accounts?.length || 0} asset accounts`}
          accentColor="text-green-600"
          icon={<Plus className="h-5 w-5" />}
          total={data?.forUsTotal || 0}
          totalLabel="Total Assets"
          totalColor="text-green-600"
          accounts={data?.forUs.accounts || []}
          amountColor="text-green-600"
          formatAmount={formatAmount}
          displayLayout={displayLayout}
          orderActions={orderActions}
        />
        <CollapsibleSection
          id="liabilities"
          onFxClick={setFxHistorySide}
          title="What We Owe"
          subtitle={`${data?.onUs.accounts?.length || 0} liability accounts`}
          accentColor="text-red-600"
          icon={<Minus className="h-5 w-5" />}
          total={data?.onUsTotal || 0}
          totalLabel="Total Liabilities"
          totalColor="text-red-600"
          accounts={data?.onUs.accounts || []}
          amountColor="text-red-600"
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
          scope="factory"
          companyId={data.companyId}
          asOf={displayAsOf}
        />
      )}
      {data && (
        <CustomNetPositionView
          key={data.companyId ?? "no-company"}
          data={data}
          formatAmount={formatAmount}
          asOf={displayAsOf}
          onFxClick={setFxHistorySide}
        />
      )}
    </div>
  );
}
