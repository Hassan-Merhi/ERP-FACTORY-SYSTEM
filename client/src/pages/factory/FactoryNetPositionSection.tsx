// Extracted from ./FactoryNetPosition.tsx to keep that module under the source-size cap.
import { visibleTabInterval } from "@/lib/queryPolicies";
import { getAppDate } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, PackageOpen, RefreshCw } from "lucide-react";
import type { NetPositionData } from "./factorynetposition/types";
import { fmt, formatDateLabel, shiftDate } from "./factorynetposition/utils";
import { OrderGroup } from "./factorynetposition/components/OrderGroup";

export function useFactoryNetPositionState() {
  const { selectedCompany } = useCompany();
  const [asOf, setAsOf] = useState<string>("");
  const [fxHistorySide, setFxHistorySide] = useState<"gain" | "loss" | null>(null);
  const isToday = !asOf;
  const { prefs, updatePref, isPending: isSavingValuationMode } = useUserPreferences();
  const valuationMode = prefs?.factoryNetPositionValuationMode === "selling" ? "selling" : "cost";

  const {
    data: rawData,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery<NetPositionData>({
    queryKey: companyQueryKey("/api/factory/net-position", selectedCompany?.id, asOf || "company-today", valuationMode),
    queryFn: async () => {
      const params = new URLSearchParams({ valuationMode });
      if (asOf) params.set("asOf", asOf);
      const res = await fetch(`/api/factory/net-position?${params.toString()}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: isToday ? 30_000 : 60_000,
    refetchInterval: isToday ? visibleTabInterval(120_000) : false,
  });

  // Supplier, customer and employee figures come from the server's balance
  // engine; the page no longer swaps in the Suppliers-page formula for today
  // (that re-mixed operational container amounts into the totals).
  const data = rawData;
  const displayAsOf = asOf || data?.asOf || getAppDate();
  const companyToday = data?.businessToday || getAppDate();

  const isPositive = (data?.netPosition ?? 0) >= 0;
  const hasPendingVerified =
    (data?.pendingOrders?.length ?? 0) + (data?.verifiedOrders?.length ?? 0) + (data?.loadingOrders?.length ?? 0) > 0;
  return {
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
  };
}

export function FactoryNetPositionCardUpcomingReceivables({
  data,
  hasPendingVerified,
}: Pick<ReturnType<typeof useFactoryNetPositionState>, "data" | "hasPendingVerified">) {
  return (
    <Card data-testid="card-upcoming-receivables">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-amber-500" />
            <CardTitle className="text-base">Upcoming Receivables</CardTitle>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {(data?.pendingTotal ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">
                Pending:{" "}
                <span className="font-mono font-semibold text-amber-500 dark:text-amber-400">
                  {fmt(data?.pendingTotal ?? 0)}
                </span>
              </span>
            )}
            {(data?.verifiedTotal ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">
                Verified:{" "}
                <span className="font-mono font-semibold text-blue-500 dark:text-blue-400">
                  {fmt(data?.verifiedTotal ?? 0)}
                </span>
              </span>
            )}
            {(data?.loadingTotal ?? 0) > 0 && (
              <span className="text-xs text-muted-foreground">
                Loading:{" "}
                <span className="font-mono font-semibold text-purple-500 dark:text-purple-400">
                  {fmt(data?.loadingTotal ?? 0)}
                </span>
              </span>
            )}
            <span className="text-xs text-muted-foreground border-l border-border pl-3">
              Total:{" "}
              <span className="font-mono font-semibold text-foreground">
                {fmt((data?.pendingTotal ?? 0) + (data?.verifiedTotal ?? 0) + (data?.loadingTotal ?? 0))}
              </span>
            </span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Verified and Loading orders are included in "What We Have" as projected, uninvoiced order values; Pending
          orders are shown for reference only. This does not post customer receivables to the ledger. Loading amounts
          update as bales are scanned.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasPendingVerified ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No pending, verified, or loading orders at this time.
          </p>
        ) : (
          <>
            <OrderGroup
              label="Pending"
              orders={data?.pendingOrders ?? []}
              total={data?.pendingTotal ?? 0}
              icon={<Clock className="h-4 w-4 text-amber-500" />}
              accentClass="text-amber-500 dark:text-amber-400"
              badgeClass="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
            />
            <OrderGroup
              label="Verified"
              orders={data?.verifiedOrders ?? []}
              total={data?.verifiedTotal ?? 0}
              icon={<CheckCircle2 className="h-4 w-4 text-blue-500" />}
              accentClass="text-blue-500 dark:text-blue-400"
              badgeClass="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
            />
            <OrderGroup
              label="Loading (In Progress)"
              orders={data?.loadingOrders ?? []}
              total={data?.loadingTotal ?? 0}
              icon={<PackageOpen className="h-4 w-4 text-purple-500" />}
              accentClass="text-purple-500 dark:text-purple-400"
              badgeClass="bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function FactoryNetPositionSection({
  companyToday,
  data,
  displayAsOf,
  isFetching,
  isSavingValuationMode,
  isToday,
  refetch,
  setAsOf,
  updatePref,
  valuationMode,
}: Pick<
  ReturnType<typeof useFactoryNetPositionState>,
  | "companyToday"
  | "data"
  | "displayAsOf"
  | "isFetching"
  | "isSavingValuationMode"
  | "isToday"
  | "refetch"
  | "setAsOf"
  | "updatePref"
  | "valuationMode"
>) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <PageHeader
          title="Net Position"
          subtitle={
            isToday
              ? "What we have vs what we owe — current standing"
              : `Historical snapshot — as of ${formatDateLabel(displayAsOf)}`
          }
        />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1 border rounded-md p-0.5" data-testid="valuation-mode-toggle">
          <Button
            variant={valuationMode === "cost" ? "default" : "ghost"}
            size="sm"
            disabled={isSavingValuationMode}
            onClick={() => updatePref({ factoryNetPositionValuationMode: "cost" })}
            data-testid="button-valuation-cost"
          >
            Cost Price
          </Button>
          <Button
            variant={valuationMode === "selling" ? "default" : "ghost"}
            size="sm"
            disabled={isSavingValuationMode}
            onClick={() => updatePref({ factoryNetPositionValuationMode: "selling" })}
            data-testid="button-valuation-selling"
          >
            Selling Price
          </Button>
        </div>
        {/* Date navigation */}
        <div className="flex items-center gap-1 border rounded-md px-1 py-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAsOf(shiftDate(displayAsOf, -1))}
            disabled={!data?.businessToday}
            data-testid="button-date-prev"
            title="Previous day"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-1.5 px-1">
            <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="date"
              value={displayAsOf}
              max={companyToday}
              disabled={!data?.businessToday}
              onChange={(e) => e.target.value && setAsOf(e.target.value >= companyToday ? "" : e.target.value)}
              className="text-sm bg-transparent border-none outline-hidden cursor-pointer w-[120px]"
              data-testid="input-as-of-date"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              const next = shiftDate(displayAsOf, 1);
              setAsOf(next >= companyToday ? "" : next);
            }}
            disabled={isToday || !data?.businessToday}
            data-testid="button-date-next"
            title="Next day"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {!isToday && (
          <Button variant="outline" size="sm" onClick={() => setAsOf("")} data-testid="button-date-today">
            Today
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>
    </div>
  );
}

export function FactoryNetPositionCardNetPosition({
  data,
  isPositive,
}: Pick<ReturnType<typeof useFactoryNetPositionState>, "data" | "isPositive">) {
  return (
    <Card
      className={`border-2 ${isPositive ? "border-green-500/30" : "border-red-500/30"}`}
      data-testid="card-net-position"
    >
      <CardContent className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div>
            <p className="text-sm text-muted-foreground mb-1">Net Position</p>
            <p
              className={`text-4xl font-bold font-mono ${isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              data-testid="text-net-position"
            >
              {data?.netPosition !== undefined && data.netPosition < 0 ? "-" : ""}
              {fmt(Math.abs(data?.netPosition ?? 0))}
            </p>
            <p className="text-sm text-muted-foreground mt-1">{data?.netPositionLabel}</p>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="text-center">
              <p className="text-xs text-muted-foreground mb-1">What We Have</p>
              <p className="text-lg font-semibold font-mono text-green-600 dark:text-green-400">
                {fmt(data?.forUsTotal ?? 0)}
              </p>
            </div>
            <div className="text-muted-foreground text-xl font-light">−</div>
            <div className="text-center">
              <p className="text-xs text-muted-foreground mb-1">What We Owe</p>
              <p className="text-lg font-semibold font-mono text-red-600 dark:text-red-400">
                {fmt(data?.onUsTotal ?? 0)}
              </p>
            </div>
            <div className="text-muted-foreground text-xl font-light">=</div>
            <div className="text-center">
              <p className="text-xs text-muted-foreground mb-1">Net</p>
              <p
                className={`text-lg font-semibold font-mono ${isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              >
                {data?.netPosition !== undefined && data.netPosition < 0 ? "-" : ""}
                {fmt(Math.abs(data?.netPosition ?? 0))}
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
