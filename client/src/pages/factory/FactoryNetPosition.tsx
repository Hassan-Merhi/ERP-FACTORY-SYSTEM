import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import {
  ChevronRight,
  ChevronLeft,
  TrendingUp,
  TrendingDown,
  Equal,
  RefreshCw,
  AlertCircle,
  Clock,
  CheckCircle2,
  PackageOpen,
  CalendarDays,
} from "lucide-react";

import type { NetPositionData } from "./factorynetposition/types";
import { fmt, formatDateLabel, r2, shiftDate, todayStr } from "./factorynetposition/utils";
import { Side } from "./factorynetposition/components/Side";
import { OrderGroup } from "./factorynetposition/components/OrderGroup";
import { CustomNetPositionView } from "./factorynetposition/components/CustomNetPositionView";
interface SupplierWithBalance {
  id: number;
  name: string;
  parentId: number | null;
  totalValue: string;
}

export default function FactoryNetPosition() {
  const [asOf, setAsOf] = useState<string>(todayStr);
  const isToday = asOf === todayStr();

  const {
    data: rawData,
    isLoading,
    error,
    refetch,
    isFetching,
  } = useQuery<NetPositionData>({
    queryKey: ["/api/factory/net-position", asOf],
    queryFn: async () => {
      const res = await fetch(`/api/factory/net-position?asOf=${asOf}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: isToday ? 30_000 : Infinity,
    refetchInterval: isToday ? 30_000 : false,
  });

  // Authoritative supplier balances — only used for today (live override).
  // For historical dates we rely solely on the date-filtered net-position endpoint.
  const { data: supplierWithBalances = [] } = useQuery<SupplierWithBalance[]>({
    queryKey: ["/api/factory/suppliers/with-balances", "net-position-merge"],
    queryFn: async () => {
      const res = await fetch("/api/factory/suppliers/with-balances?includeOtw=true", { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 30_000,
    enabled: !!rawData && isToday,
  });

  // Merge: override supplier balances with the authoritative with-balances data,
  // then recompute all affected totals so the page is fully consistent.
  const data = useMemo((): NetPositionData | undefined => {
    if (!rawData) return undefined;
    if (!supplierWithBalances.length) return rawData;

    // Each entry has id, name, totalValue (USD balance as string).
    // Skip broker children (parentId set) — their balances are already rolled into the
    // broker parent's grand total via buildBrokerStatement, so including them separately
    // would double-count their EUR/AUD exposure.
    const correctedItems = supplierWithBalances
      .filter((s) => !s.parentId)
      .map((s) => ({ id: s.id, name: s.name, balanceUsd: parseFloat(s.totalValue || "0") }))
      .filter((s) => Math.abs(s.balanceUsd) > 0.01);

    const correctedLiabilities = r2(
      correctedItems.filter((s) => s.balanceUsd > 0).reduce((sum, s) => sum + s.balanceUsd, 0)
    );
    const correctedOverpayments = r2(
      correctedItems.filter((s) => s.balanceUsd < 0).reduce((sum, s) => sum + Math.abs(s.balanceUsd), 0)
    );

    const liabilityDelta = correctedLiabilities - rawData.supplierLiabilities;
    const overpaymentDelta = correctedOverpayments - (rawData.supplierOverpayments ?? 0);

    const correctedOnUsTotal = r2(rawData.onUs.total + liabilityDelta);
    const correctedForUsTotal = r2(rawData.forUs.total + overpaymentDelta);
    const correctedNetPosition = r2(correctedForUsTotal - correctedOnUsTotal);

    // Replace SUPPLIER accounts in onUs with corrected items
    const nonSupplierOnUs = rawData.onUs.accounts.filter((a) => a.code !== "SUPPLIER");
    const correctedOnUsAccounts = [
      ...correctedItems
        .filter((s) => s.balanceUsd > 0)
        .sort((a, b) => b.balanceUsd - a.balanceUsd)
        .map((s) => ({ id: s.id, name: s.name, code: "SUPPLIER", value: r2(s.balanceUsd), category: "Supplier" })),
      ...nonSupplierOnUs,
    ];

    // Replace SUPPLIER_OVERPAID accounts in forUs with corrected items
    const nonSupplierForUs = rawData.forUs.accounts.filter((a) => a.code !== "SUPPLIER_OVERPAID");
    const correctedForUsAccounts = [
      ...nonSupplierForUs,
      ...correctedItems
        .filter((s) => s.balanceUsd < 0)
        .sort((a, b) => a.balanceUsd - b.balanceUsd)
        .map((s) => ({
          id: s.id,
          name: s.name,
          code: "SUPPLIER_OVERPAID",
          value: r2(Math.abs(s.balanceUsd)),
          category: "Supplier Overpayments",
        })),
    ];

    // Update onUs breakdown — replace or add "Suppliers" line
    let correctedOnUsBreakdown = rawData.onUs.breakdown.map((b) =>
      b.name === "Suppliers" ? { ...b, value: correctedLiabilities } : b
    );
    if (correctedLiabilities > 0 && !correctedOnUsBreakdown.some((b) => b.name === "Suppliers")) {
      correctedOnUsBreakdown = [{ name: "Suppliers", value: correctedLiabilities }, ...correctedOnUsBreakdown];
    }
    // Remove "Suppliers" line if no liabilities
    if (correctedLiabilities === 0) {
      correctedOnUsBreakdown = correctedOnUsBreakdown.filter((b) => b.name !== "Suppliers");
    }

    const correctedForUsBreakdown = rawData.forUs.breakdown.map((b) =>
      b.name === "Supplier Overpayments" ? { ...b, value: correctedOverpayments } : b
    );

    return {
      ...rawData,
      netPosition: correctedNetPosition,
      netPositionLabel: correctedNetPosition >= 0 ? "We have more than we owe" : "We owe more than we have",
      forUsTotal: correctedForUsTotal,
      onUsTotal: correctedOnUsTotal,
      supplierLiabilities: correctedLiabilities,
      supplierOverpayments: correctedOverpayments,
      forUs: {
        ...rawData.forUs,
        total: correctedForUsTotal,
        accounts: correctedForUsAccounts,
        breakdown: correctedForUsBreakdown,
      },
      onUs: {
        ...rawData.onUs,
        total: correctedOnUsTotal,
        accounts: correctedOnUsAccounts,
        breakdown: correctedOnUsBreakdown,
      },
    };
  }, [rawData, supplierWithBalances]);

  const isPositive = (data?.netPosition ?? 0) >= 0;
  const hasPendingVerified =
    (data?.pendingOrders?.length ?? 0) + (data?.verifiedOrders?.length ?? 0) + (data?.loadingOrders?.length ?? 0) > 0;

  if (error) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <p>Failed to load net position data.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <PageHeader
            title="Net Position"
            subtitle={
              isToday
                ? "What we have vs what we owe — current standing"
                : `Historical snapshot — as of ${formatDateLabel(asOf)}`
            }
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Date navigation */}
          <div className="flex items-center gap-1 border rounded-md px-1 py-0.5">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAsOf(shiftDate(asOf, -1))}
              data-testid="button-date-prev"
              title="Previous day"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-1.5 px-1">
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="date"
                value={asOf}
                max={todayStr()}
                onChange={(e) => e.target.value && setAsOf(e.target.value)}
                className="text-sm bg-transparent border-none outline-none cursor-pointer w-[120px]"
                data-testid="input-as-of-date"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setAsOf(shiftDate(asOf, 1))}
              disabled={isToday}
              data-testid="button-date-next"
              title="Next day"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {!isToday && (
            <Button variant="outline" size="sm" onClick={() => setAsOf(todayStr())} data-testid="button-date-today">
              Today
            </Button>
          )}
          {isToday && (
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
          )}
        </div>
      </div>

      {/* Historical mode banner */}
      {!isToday && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-sm">
          <CalendarDays className="h-4 w-4 shrink-0" />
          <span>
            Showing net position as of <strong>{formatDateLabel(asOf)}</strong>. Supplier payments, vouchers, and
            customer balances are filtered to that date. Inventory reflects current stock.
          </span>
        </div>
      )}

      {/* Net Position Banner */}
      {isLoading ? (
        <Skeleton className="h-28 w-full rounded-md" />
      ) : (
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
            sublabel="Assets owed to us — cash, inventory, receivables, customer balances (Dr)"
            total={data?.forUs.total ?? 0}
            breakdown={data?.forUs.breakdown ?? []}
            accounts={data?.forUs.accounts ?? []}
            colorClass="text-green-600 dark:text-green-400"
            icon={<TrendingUp className="h-5 w-5 text-green-600 dark:text-green-400" />}
          />
          <Side
            label="What We Owe"
            sublabel="Liabilities — supplier balances and other payables"
            total={data?.onUs.total ?? 0}
            breakdown={data?.onUs.breakdown ?? []}
            accounts={data?.onUs.accounts ?? []}
            colorClass="text-red-600 dark:text-red-400"
            icon={<TrendingDown className="h-5 w-5 text-red-600 dark:text-red-400" />}
          />
        </div>
      )}

      {/* Custom Net Position View — view-only, user-configurable account visibility */}
      {!isLoading && data && <CustomNetPositionView data={data} />}

      {/* Broker Balance Breakdown */}
      {!isLoading && (data?.onUs.accounts ?? []).some((a) => a.code === "SUPPLIER" && a.breakdown?.length) && (
        <Card data-testid="card-broker-breakdown">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Broker Balance Breakdown</CardTitle>
            <p className="text-xs text-muted-foreground">Step-by-step calculation for each broker supplier</p>
          </CardHeader>
          <CardContent className="space-y-4">
            {(data?.onUs.accounts ?? [])
              .filter((a) => a.code === "SUPPLIER" && a.breakdown?.length)
              .map((broker, bi) => (
                <div key={bi} className="border border-border rounded-md overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-muted/30">
                    <span className="font-semibold text-sm">{broker.name}</span>
                    <span className="font-mono text-sm font-bold text-red-600 dark:text-red-400">
                      {fmt(broker.value)}
                    </span>
                  </div>
                  <div className="px-4 py-3 space-y-1.5">
                    {broker.breakdown!.map((line, j) => {
                      const isNeg = line.usd < 0;
                      const isFxOnly = line.usd === 0;
                      const isTotal = line.label.includes("Net Balance") || line.label.includes("× ");
                      return (
                        <div
                          key={j}
                          className={`flex items-center justify-between text-xs gap-4 ${isTotal ? "border-t border-border pt-1.5 mt-1" : ""}`}
                        >
                          <div className="min-w-0">
                            <span className={isTotal ? "font-medium" : "text-foreground/80"}>{line.label}</span>
                            <span className="ml-2 font-mono text-muted-foreground">({line.native})</span>
                          </div>
                          <span
                            className={`font-mono shrink-0 font-medium ${isNeg ? "text-destructive" : isFxOnly ? "text-muted-foreground" : "text-foreground"}`}
                          >
                            {line.usd !== 0 ? fmt(line.usd) : "—"}
                          </span>
                        </div>
                      );
                    })}
                    <div className="border-t-2 border-border pt-2 mt-1 flex justify-between text-sm font-bold">
                      <span>Total Owed</span>
                      <span className="font-mono text-red-600 dark:text-red-400">{fmt(broker.value)}</span>
                    </div>
                  </div>
                </div>
              ))}
          </CardContent>
        </Card>
      )}

      {/* Upcoming Receivables — Pending, Verified & Loading Orders */}
      {isLoading ? (
        <Skeleton className="h-48 w-full rounded-md" />
      ) : (
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
              Pending and Verified orders are included in "What We Have." Loading orders update live as bales are
              scanned.
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
