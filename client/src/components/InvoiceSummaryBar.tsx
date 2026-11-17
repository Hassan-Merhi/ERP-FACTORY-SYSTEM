import { cn } from "@/lib/utils";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";

interface OrderLike {
  status: string;
  grandTotal: string;
  totalQtyBales: number;
  totalWeightKg: string;
  proformaExpectedBales?: string;
  loadedNotInProformaBales?: string;
}

interface Bucket {
  label: string;
  color: string;
  dotColor: string;
  orders: OrderLike[];
}

function fmt(n: number) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function sum(orders: OrderLike[], field: "grandTotal" | "totalWeightKg") {
  return orders.reduce((s, o) => s + parseFloat(o[field] || "0"), 0);
}

function sumBales(orders: OrderLike[]) {
  return orders.reduce((s, o) => s + (o.totalQtyBales || 0), 0);
}

interface LoadingStats {
  remainingBales: number;
  remainingKg: number;
  remainingPrice: number;
  overloadedBales: number;
  overloadedKg: number;
  overloadedPrice: number;
  underLoadedBales: number;
  underLoadedKg: number;
  underLoadedPrice: number;
  notRequestedBales: number;
  notRequestedKg: number;
  notRequestedPrice: number;
}

export function InvoiceSummaryBar({
  orders,
  hideTotalsUsd = false,
  getRemainingBales,
  getEstimatedKg,
  getEstimatedPrice,
}: {
  orders: OrderLike[];
  hideTotalsUsd?: boolean;
  getRemainingBales?: (order: OrderLike) => number;
  getEstimatedKg?: (order: OrderLike, bales: number) => number;
  getEstimatedPrice?: (order: OrderLike, bales: number) => number;
}) {
  const buckets: Bucket[] = [
    {
      label: "Pending Verification",
      color: "text-yellow-700 dark:text-yellow-400",
      dotColor: "bg-yellow-400",
      orders: orders.filter((o) => o.status === "PENDING_VERIFICATION"),
    },
    {
      label: "Verified",
      color: "text-green-700 dark:text-green-400",
      dotColor: "bg-green-500",
      orders: orders.filter((o) => o.status === "VERIFIED"),
    },
    {
      label: "Loading",
      color: "text-blue-700 dark:text-blue-400",
      dotColor: "bg-blue-500",
      orders: orders.filter((o) => o.status === "LOADING"),
    },
    {
      label: "Finalized",
      color: "text-foreground",
      dotColor: "bg-primary",
      orders: orders.filter((o) => o.status === "FINALIZED"),
    },
    {
      label: "Draft",
      color: "text-muted-foreground",
      dotColor: "bg-muted-foreground",
      orders: orders.filter((o) => o.status === "DRAFT"),
    },
  ].filter((b) => b.orders.length > 0);

  if (buckets.length === 0) return null;

  const totalBales = sumBales(orders);
  const totalWeight = sum(orders, "totalWeightKg");
  const totalAmount = sum(orders, "grandTotal");

  // Compute loading analysis stats when helpers are provided
  let loadingStats: LoadingStats | null = null;
  if (getRemainingBales && getEstimatedKg && getEstimatedPrice) {
    const stats: LoadingStats = {
      remainingBales: 0,
      remainingKg: 0,
      remainingPrice: 0,
      overloadedBales: 0,
      overloadedKg: 0,
      overloadedPrice: 0,
      underLoadedBales: 0,
      underLoadedKg: 0,
      underLoadedPrice: 0,
      notRequestedBales: 0,
      notRequestedKg: 0,
      notRequestedPrice: 0,
    };

    for (const order of orders) {
      const expected = parseFloat(order.proformaExpectedBales || "0");
      const loaded = order.totalQtyBales || 0;
      const notReq = parseInt(order.loadedNotInProformaBales || "0");

      if (expected > 0) {
        if (loaded < expected) {
          // Under loaded order: remaining bales needed
          const rem = expected - loaded;
          stats.remainingBales += rem;
          stats.remainingKg += getEstimatedKg(order, rem);
          stats.remainingPrice += getEstimatedPrice(order, rem);
          // Under loaded: what's currently loaded in these orders
          stats.underLoadedBales += loaded;
          stats.underLoadedKg += parseFloat(order.totalWeightKg || "0");
          stats.underLoadedPrice += parseFloat(order.grandTotal || "0");
        } else if (loaded > expected) {
          // Overloaded order: excess bales
          const over = loaded - expected;
          stats.overloadedBales += over;
          stats.overloadedKg += getEstimatedKg(order, over);
          stats.overloadedPrice += getEstimatedPrice(order, over);
        }
      }

      if (notReq > 0) {
        stats.notRequestedBales += notReq;
        // Estimate kg/price for not-requested bales using order average
        stats.notRequestedKg += getEstimatedKg(order, notReq);
        stats.notRequestedPrice += getEstimatedPrice(order, notReq);
      }
    }

    // Only show if at least one stat is non-zero
    if (
      stats.remainingBales > 0 ||
      stats.overloadedBales > 0 ||
      stats.underLoadedBales > 0 ||
      stats.notRequestedBales > 0
    ) {
      loadingStats = stats;
    }
  }

  return (
    <div className="rounded-md border bg-muted/40 p-3 mb-4 space-y-2" data-testid="invoice-summary-bar">
      {/* Overall total */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground border-b pb-2">
        <span className="font-semibold text-foreground text-sm">{orders.length} orders total</span>
        <span>
          <span className="font-medium text-foreground">{totalBales.toLocaleString()}</span> bales
        </span>
        <span>
          <span className="font-medium text-foreground">{fmt(totalWeight)}</span> kg
        </span>
        {!hideTotalsUsd && (
          <span>
            <span className="font-medium text-foreground">
              {formatMoneyDisplay(totalAmount, { currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 })}
            </span>
          </span>
        )}
      </div>

      {/* Per-status breakdown */}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {buckets.map((b) => {
          const bales = sumBales(b.orders);
          const weight = sum(b.orders, "totalWeightKg");
          const amount = sum(b.orders, "grandTotal");
          return (
            <div
              key={b.label}
              className="flex items-start gap-2 min-w-[180px]"
              data-testid={`summary-bucket-${b.label.replace(/\s/g, "-").toLowerCase()}`}
            >
              <span className={cn("mt-0.5 h-2.5 w-2.5 rounded-full shrink-0", b.dotColor)} />
              <div className="text-xs">
                <div className={cn("font-semibold leading-tight", b.color)}>
                  {b.label} <span className="font-normal text-muted-foreground">({b.orders.length})</span>
                </div>
                <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                  <span>
                    <span className="font-medium text-foreground">{bales.toLocaleString()}</span> bales
                  </span>
                  <span>
                    <span className="font-medium text-foreground">{fmt(weight)}</span> kg
                  </span>
                  {!hideTotalsUsd && (
                    <span>
                      <span className="font-medium text-foreground">
                        {formatMoneyDisplay(amount, {
                          currency: "USD",
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Loading analysis — shown when proforma data is available */}
      {loadingStats && (
        <div className="border-t pt-2 mt-1">
          <p className="text-xs font-semibold text-muted-foreground mb-2">Loading Analysis</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {loadingStats.remainingBales > 0 && (
              <div className="flex items-start gap-2" data-testid="summary-remaining-to-load">
                <span className="mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 bg-red-500" />
                <div className="text-xs">
                  <div className="font-semibold leading-tight text-red-700 dark:text-red-400">
                    Remaining to be Loaded
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                    <span>
                      <span className="font-medium text-foreground">
                        {loadingStats.remainingBales.toLocaleString()}
                      </span>{" "}
                      bales
                    </span>
                    <span>
                      <span className="font-medium text-foreground">{fmt(loadingStats.remainingKg)}</span> kg
                    </span>
                    {!hideTotalsUsd && (
                      <span className="text-muted-foreground/70">
                        est.{" "}
                        <span className="font-medium text-foreground">
                          {formatMoneyDisplay(loadingStats.remainingPrice, {
                            currency: "USD",
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {loadingStats.overloadedBales > 0 && (
              <div className="flex items-start gap-2" data-testid="summary-overloaded">
                <span className="mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 bg-amber-500" />
                <div className="text-xs">
                  <div className="font-semibold leading-tight text-amber-700 dark:text-amber-400">Overloaded</div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                    <span>
                      <span className="font-medium text-foreground">
                        +{loadingStats.overloadedBales.toLocaleString()}
                      </span>{" "}
                      bales
                    </span>
                    <span>
                      <span className="font-medium text-foreground">{fmt(loadingStats.overloadedKg)}</span> kg
                    </span>
                    {!hideTotalsUsd && (
                      <span className="text-muted-foreground/70">
                        est.{" "}
                        <span className="font-medium text-foreground">
                          {formatMoneyDisplay(loadingStats.overloadedPrice, {
                            currency: "USD",
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {loadingStats.underLoadedBales > 0 && (
              <div className="flex items-start gap-2" data-testid="summary-under-loaded">
                <span className="mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 bg-orange-400" />
                <div className="text-xs">
                  <div className="font-semibold leading-tight text-orange-700 dark:text-orange-400">Under Loaded</div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                    <span>
                      <span className="font-medium text-foreground">
                        {loadingStats.underLoadedBales.toLocaleString()}
                      </span>{" "}
                      bales
                    </span>
                    <span>
                      <span className="font-medium text-foreground">{fmt(loadingStats.underLoadedKg)}</span> kg
                    </span>
                    {!hideTotalsUsd && (
                      <span>
                        <span className="font-medium text-foreground">
                          {formatMoneyDisplay(loadingStats.underLoadedPrice, {
                            currency: "USD",
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {loadingStats.notRequestedBales > 0 && (
              <div className="flex items-start gap-2" data-testid="summary-not-requested">
                <span className="mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 bg-purple-500" />
                <div className="text-xs">
                  <div className="font-semibold leading-tight text-purple-700 dark:text-purple-400">
                    Loaded Not Requested
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                    <span>
                      <span className="font-medium text-foreground">
                        {loadingStats.notRequestedBales.toLocaleString()}
                      </span>{" "}
                      bales
                    </span>
                    <span>
                      <span className="font-medium text-foreground">{fmt(loadingStats.notRequestedKg)}</span> kg
                    </span>
                    {!hideTotalsUsd && (
                      <span className="text-muted-foreground/70">
                        est.{" "}
                        <span className="font-medium text-foreground">
                          {formatMoneyDisplay(loadingStats.notRequestedPrice, {
                            currency: "USD",
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 2,
                          })}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
