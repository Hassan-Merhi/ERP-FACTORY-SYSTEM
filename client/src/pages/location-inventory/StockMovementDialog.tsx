import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Package, ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PeriodFilter } from "@/components/ui/period-filter";
import type {
  StockMovementItem,
  StockMovementMonth,
  StockMovementPeriod,
} from "./locationInventoryTypes";

interface StockMovementDialogProps {
  stockMovementOpen: boolean;
  setStockMovementOpen: (o: boolean) => void;
  stockMovementItem: StockMovementItem | null;
  setStockMovementItem: (item: StockMovementItem | null) => void;
  stockMovementPeriod: StockMovementPeriod;
  setStockMovementPeriod: (period: StockMovementPeriod) => void;
  drillMonth: StockMovementMonth | null;
  setDrillMonth: (month: StockMovementMonth | null) => void;
  formatAmount: (amt: number) => string;
  navigate: (path: string) => void;
}

export function StockMovementDialog({
  stockMovementOpen,
  setStockMovementOpen,
  stockMovementItem,
  setStockMovementItem,
  stockMovementPeriod,
  setStockMovementPeriod,
  drillMonth,
  setDrillMonth,
  formatAmount,
  navigate,
}: StockMovementDialogProps) {
  const toSafeNumber = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const fmtN = (value: unknown, dec = 2) => {
    const n = toSafeNumber(value);
    return n === 0 ? (
      <span className="text-muted-foreground/30">—</span>
    ) : (
      <>{n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}</>
    );
  };
  const fmtA = (value: unknown) => {
    const n = toSafeNumber(value);
    return n === 0 ? <span className="text-muted-foreground/30">—</span> : <>{formatAmount(n)}</>;
  };

  const { data: stockMovementData, isLoading: stockMovementLoading } = useQuery({
    queryKey: stockMovementItem
      ? ["/api/inventory/movement", stockMovementItem.stockItemId, stockMovementItem.locationId, stockMovementPeriod]
      : [],
    enabled: stockMovementOpen && !!stockMovementItem,
    queryFn: async () => {
      if (!stockMovementItem) throw new Error("No item");
      let url = `/api/inventory/movement?stockItemId=${stockMovementItem.stockItemId}`;
      if (stockMovementItem.locationId != null) url += `&locationId=${stockMovementItem.locationId}`;
      if (stockMovementPeriod?.fromDate) url += `&startDate=${stockMovementPeriod.fromDate}`;
      if (stockMovementPeriod?.toDate) url += `&endDate=${stockMovementPeriod.toDate}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const { data: smDrillData, isLoading: smDrillLoading } = useQuery({
    queryKey:
      stockMovementItem && drillMonth
        ? [
            "/api/inventory/movement/drill",
            stockMovementItem.stockItemId,
            stockMovementItem.locationId,
            drillMonth.year,
            drillMonth.month,
          ]
        : [],
    enabled: stockMovementOpen && !!stockMovementItem && !!drillMonth,
    queryFn: async () => {
      if (!stockMovementItem || !drillMonth) throw new Error("No item or month");
      let url = `/api/inventory/movement/drill?stockItemId=${stockMovementItem.stockItemId}&year=${drillMonth.year}&month=${drillMonth.month}`;
      if (stockMovementItem.locationId != null) url += `&locationId=${stockMovementItem.locationId}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const smRowsWithYear = stockMovementData?.months || [];

  return (
    <Dialog open={stockMovementOpen} onOpenChange={setStockMovementOpen}>
      <DialogContent className="max-w-5xl w-[95vw] h-[90vh] p-0 flex flex-col gap-0 overflow-hidden">
        <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Package className="h-5 w-5 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-xl">Stock Movement</DialogTitle>
                <DialogDescription className="text-xs">
                  {stockMovementItem?.stockItemName}{" "}
                  {stockMovementItem?.locationName ? `at ${stockMovementItem.locationName}` : "(All Locations)"}
                </DialogDescription>
              </div>
            </div>
            {!drillMonth && (
              <div className="flex items-center gap-2">
                <PeriodFilter value={stockMovementPeriod} onChange={setStockMovementPeriod} />
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto bg-background p-0 scrollbar-thin">
          {drillMonth ? (
            /* ── Drill-down transaction table ── */
            smDrillLoading ? (
              <div className="p-6 space-y-2">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              <table className="w-full text-sm border-collapse" style={{ minWidth: 860 }}>
                <thead className="sticky top-0 z-20">
                  <tr className="bg-muted border-b">
                    <th rowSpan={2} className="text-left align-bottom px-4 py-2 border-r font-semibold w-24">
                      Date
                    </th>
                    <th rowSpan={2} className="text-left align-bottom px-4 py-2 border-r font-semibold">
                      Particulars
                    </th>
                    <th rowSpan={2} className="text-left align-bottom px-4 py-2 border-r font-semibold w-32">
                      Vch Type
                    </th>
                    <th
                      colSpan={3}
                      className="text-center px-2 py-1.5 border-r font-semibold text-green-700 dark:text-green-400 text-xs"
                    >
                      Inward
                    </th>
                    <th
                      colSpan={3}
                      className="text-center px-2 py-1.5 border-r font-semibold text-red-700 dark:text-red-400 text-xs"
                    >
                      Outward
                    </th>
                    <th colSpan={3} className="text-center px-2 py-1.5 font-semibold text-primary text-xs">
                      Closing
                    </th>
                  </tr>
                  <tr className="bg-muted/70 border-b text-xs">
                    {["Qty", "Rate", "Value", "Qty", "Rate", "Value", "Qty", "Rate", "Value"].map((h, i) => (
                      <th
                        key={i}
                        className={cn(
                          "text-right px-3 py-1.5 font-medium whitespace-nowrap",
                          i < 3
                            ? "text-green-700 dark:text-green-400 border-r"
                            : i < 6
                              ? "text-red-700 dark:text-red-400 border-r"
                              : "text-primary"
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(!smDrillData?.transactions || smDrillData.transactions.length === 0) && (
                    <tr>
                      <td colSpan={12} className="text-center py-12 text-muted-foreground">
                        No transactions for {drillMonth.monthName} {drillMonth.year}
                      </td>
                    </tr>
                  )}
                  {smDrillData?.transactions?.map((txn: any, idx: number) => {
                    const editUrl = (() => {
                      if (txn.isOpeningBalance) return null;
                      const vt = (txn.vchType || "").toLowerCase();
                      if (vt === "purchase import") return txn.poId ? `/purchase-orders/${txn.poId}/edit` : null;
                      if (vt === "production" || vt === "consumption")
                        return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
                      if (vt.startsWith("pos") || vt.includes("pos"))
                        return txn.voucherId ? `/pos/edit/${txn.voucherId}` : null;
                      if (vt.startsWith("stock transfer"))
                        return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
                      if (vt === "sales") return txn.voucherId ? `/vouchers/${txn.voucherId}/edit` : null;
                      return null;
                    })();
                    const dispDate = (() => {
                      if (txn.isOpeningBalance) return "";
                      try {
                        return format(new Date(txn.date), "dd MMM");
                      } catch {
                        return txn.date || "";
                      }
                    })();
                    return (
                      <tr
                        key={idx}
                        data-testid={`row-drill-txn-${idx}`}
                        className={cn(
                          "border-b",
                          txn.isOpeningBalance ? "bg-muted/30 font-medium" : idx % 2 === 1 ? "bg-muted/10" : ""
                        )}
                      >
                        <td className="px-4 py-2 border-r tabular-nums text-muted-foreground text-xs whitespace-nowrap">
                          {dispDate}
                        </td>
                        <td className="px-4 py-2 border-r">
                          {editUrl ? (
                            <button
                              onClick={() => {
                                window.open(editUrl, "_blank", "noopener,noreferrer");
                              }}
                              className="text-left text-primary hover:underline"
                              data-testid={`link-drill-particulars-${idx}`}
                            >
                              {txn.particulars}
                            </button>
                          ) : (
                            <>
                              <span>{txn.particulars}</span>
                              {txn.isOpeningBalance && (
                                <span
                                  className="block text-xs font-normal text-muted-foreground mt-0.5"
                                  data-testid={`text-opening-balance-location-${idx}`}
                                >
                                  {stockMovementItem?.locationName || "All Locations"}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-4 py-2 border-r text-xs text-muted-foreground whitespace-nowrap">
                          {txn.vchType}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-green-700 dark:text-green-400">
                          {fmtN(txn.inwardQty, 0)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-green-700 dark:text-green-400">
                          {fmtA(txn.inwardRate)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-green-700 dark:text-green-400 border-r">
                          {fmtA(txn.inwardValue)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-red-700 dark:text-red-400">
                          {fmtN(txn.outwardQty, 0)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-red-700 dark:text-red-400">
                          {fmtA(txn.posSellingRate ? txn.posSellingRate : txn.outwardRate)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-red-700 dark:text-red-400 border-r">
                          {fmtA(txn.posSellingValue ? txn.posSellingValue : txn.outwardValue)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-semibold text-primary">
                          {fmtN(txn.closingQty, 0)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-primary">{fmtA(txn.closingRate)}</td>
                        <td className="px-3 py-2 text-right font-mono font-semibold text-primary">
                          {fmtA(txn.closingValue)}
                        </td>
                      </tr>
                    );
                  })}
                  {smDrillData?.totals &&
                    smDrillData.transactions?.length > 0 &&
                    (() => {
                      const t = smDrillData.totals;
                      return (
                        <tr className="bg-muted/50 border-t-2 font-semibold text-sm">
                          <td colSpan={3} className="px-4 py-2.5 border-r">
                            Totals
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-green-700 dark:text-green-400">
                            {fmtN(t.inwardQty, 0)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-green-700 dark:text-green-400">
                            {fmtA(t.inwardRate)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-green-700 dark:text-green-400 border-r">
                            {fmtA(t.inwardValue)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-red-700 dark:text-red-400">
                            {fmtN(t.outwardQty, 0)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-red-700 dark:text-red-400">
                            {fmtA(t.outwardRate)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-red-700 dark:text-red-400 border-r">
                            {fmtA(t.outwardValue)}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-primary">{fmtN(t.closingQty, 0)}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-primary">{fmtA(t.closingRate)}</td>
                          <td className="px-3 py-2.5 text-right font-mono text-primary">{fmtA(t.closingValue)}</td>
                        </tr>
                      );
                    })()}
                </tbody>
              </table>
            )
          ) : /* ── Monthly summary table ── */
          stockMovementLoading ? (
            <div className="p-6 space-y-2">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <table className="w-full text-sm border-collapse" style={{ minWidth: 860 }}>
              <thead className="sticky top-0 z-20">
                <tr className="bg-muted border-b">
                  <th
                    rowSpan={2}
                    className="text-left align-bottom px-4 py-2 border-r font-semibold w-28 whitespace-nowrap"
                  >
                    Month
                  </th>
                  <th
                    colSpan={3}
                    className="text-center px-2 py-1.5 border-r font-semibold text-muted-foreground text-xs"
                  >
                    Opening
                  </th>
                  <th
                    colSpan={3}
                    className="text-center px-2 py-1.5 border-r font-semibold text-green-700 dark:text-green-400 text-xs"
                  >
                    Stock In
                  </th>
                  <th
                    colSpan={3}
                    className="text-center px-2 py-1.5 border-r font-semibold text-red-700 dark:text-red-400 text-xs"
                  >
                    Stock Out
                  </th>
                  <th colSpan={3} className="text-center px-2 py-1.5 font-semibold text-primary text-xs">
                    Closing
                  </th>
                </tr>
                <tr className="bg-muted/70 border-b text-xs">
                  {["Qty", "Rate", "Value", "Qty", "Rate", "Value", "Qty", "Rate", "Value", "Qty", "Rate", "Value"].map(
                    (h, i) => (
                      <th
                        key={i}
                        className={cn(
                          "text-right px-3 py-1.5 font-medium whitespace-nowrap",
                          i < 3
                            ? "text-muted-foreground border-r"
                            : i < 6
                              ? "text-green-700 dark:text-green-400 border-r"
                              : i < 9
                                ? "text-red-700 dark:text-red-400 border-r"
                                : "text-primary"
                        )}
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {smRowsWithYear.length === 0 && (
                  <tr>
                    <td colSpan={13} className="text-center py-12 text-muted-foreground">
                      No stock movement for this period
                    </td>
                  </tr>
                )}
                {smRowsWithYear.map((m: any, idx: number) => {
                  const hasActivity = m.inwardQty > 0 || m.outwardQty > 0 || m.openingQty !== 0 || m.closingQty !== 0;
                  const fmtQ = (n: number) =>
                    n === 0 ? (
                      <span className="text-muted-foreground/30">—</span>
                    ) : (
                      <>{n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</>
                    );
                  const fmtR = (n: number) =>
                    n === 0 ? (
                      <span className="text-muted-foreground/30">—</span>
                    ) : (
                      <>{n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
                    );
                  const fmtV = (n: number) =>
                    n === 0 ? <span className="text-muted-foreground/30">—</span> : <>{formatAmount(n)}</>;
                  return (
                    <tr
                      key={m.month}
                      data-testid={`row-sm-month-${m.month}`}
                      className={cn(
                        "border-b transition-colors cursor-pointer hover-elevate",
                        hasActivity ? "" : "opacity-40",
                        idx % 2 === 0 ? "bg-background" : "bg-muted/20"
                      )}
                      onClick={() => setDrillMonth({ year: m.year, month: m.month, monthName: m.monthName })}
                    >
                      <td className="px-4 py-2 font-semibold border-r whitespace-nowrap">
                        <span className="flex items-center gap-1">
                          {m.monthName}
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40" />
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground">{fmtQ(m.openingQty)}</td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground">{fmtR(m.openingRate)}</td>
                      <td className="px-3 py-2 text-right font-mono text-muted-foreground border-r">
                        {fmtV(m.openingValue)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-green-700 dark:text-green-400">
                        {fmtQ(m.inwardQty)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-green-700 dark:text-green-400">
                        {fmtR(m.inwardRate)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-green-700 dark:text-green-400 border-r">
                        {fmtV(m.inwardValue)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-red-700 dark:text-red-400">
                        {fmtQ(m.outwardQty)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-red-700 dark:text-red-400">
                        {fmtR(m.outwardRate)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-red-700 dark:text-red-400 border-r">
                        {fmtV(m.outwardValue)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-primary">
                        {fmtQ(m.closingQty)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-primary">
                        {fmtR(m.closingRate)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-primary">
                        {fmtV(m.closingValue)}
                      </td>
                    </tr>
                  );
                })}
                {smRowsWithYear.length > 0 &&
                  stockMovementData?.grandTotal &&
                  (() => {
                    const gt = stockMovementData.grandTotal;
                    const inRate = gt.inwardQty > 0 ? gt.inwardValue / gt.inwardQty : 0;
                    const outRate = gt.outwardQty > 0 ? gt.outwardValue / gt.outwardQty : 0;
                    const clsRate = gt.closingQty > 0 ? gt.closingValue / gt.closingQty : 0;
                    const fmtQ = (n: number) =>
                      n === 0 ? (
                        <span className="text-muted-foreground/30">—</span>
                      ) : (
                        <>{n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</>
                      );
                    const fmtR = (n: number) =>
                      n === 0 ? (
                        <span className="text-muted-foreground/30">—</span>
                      ) : (
                        <>{n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
                      );
                    const fmtV = (n: number) =>
                      n === 0 ? <span className="text-muted-foreground/30">—</span> : <>{formatAmount(n)}</>;
                    return (
                      <tr className="bg-muted/50 border-t-2 font-semibold text-sm">
                        <td className="px-4 py-2.5 border-r">Total</td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                          {fmtQ(smRowsWithYear[0]?.openingQty ?? 0)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                          {fmtR(smRowsWithYear[0]?.openingRate ?? 0)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground border-r">
                          {fmtV(smRowsWithYear[0]?.openingValue ?? 0)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-green-700 dark:text-green-400">
                          {fmtQ(gt.inwardQty)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-green-700 dark:text-green-400">
                          {fmtR(inRate)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-green-700 dark:text-green-400 border-r">
                          {fmtV(gt.inwardValue)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-red-700 dark:text-red-400">
                          {fmtQ(gt.outwardQty)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-red-700 dark:text-red-400">
                          {fmtR(outRate)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-red-700 dark:text-red-400 border-r">
                          {fmtV(gt.outwardValue)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-primary">{fmtQ(gt.closingQty)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-primary">{fmtR(clsRate)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-primary">{fmtV(gt.closingValue)}</td>
                      </tr>
                    );
                  })()}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t flex-shrink-0">
          <div>
            {drillMonth && (
              <span className="text-xs text-muted-foreground">Press Esc to return to monthly summary</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {drillMonth ? (
              <Button variant="outline" onClick={() => setDrillMonth(null)} data-testid="button-sm-back-to-months">
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Back to months
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setStockMovementOpen(false)} data-testid="button-sm-close">
                Close
              </Button>
            )}
            {stockMovementItem && (
              <Button
                onClick={() => {
                  const locId = stockMovementItem.locationId;
                  const sid = stockMovementItem.stockItemId;
                  if (drillMonth) {
                    if (locId) {
                      navigate(
                        `/locations/${locId}/stock-items/${sid}/vouchers/${drillMonth.year}/${drillMonth.month}`
                      );
                    }
                  } else {
                    if (locId) {
                      navigate(`/locations/${locId}/stock-items/${sid}/history`);
                    } else {
                      navigate(`/stock-items/${sid}/monthly-summary`);
                    }
                  }
                  setDrillMonth(null);
                  setStockMovementOpen(false);
                  setStockMovementItem(null);
                }}
                data-testid="button-sm-open-full"
              >
                <ArrowRight className="h-4 w-4 mr-1.5" />
                {drillMonth ? "Open in full view" : "Open full history"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
