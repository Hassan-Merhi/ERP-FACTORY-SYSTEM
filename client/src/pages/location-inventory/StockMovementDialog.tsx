import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Package, ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PeriodFilter } from "@/components/ui/period-filter";
import type {
  StockMovementDrillResponse,
  StockMovementItem,
  StockMovementMonth,
  StockMovementPeriod,
  StockMovementResponse,
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

const MOVEMENT_EPSILON = 0.000001;

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
      <span className="text-muted-foreground/35">—</span>
    ) : (
      <>{n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}</>
    );
  };

  const fmtA = (value: unknown) => {
    const n = toSafeNumber(value);
    return n === 0 ? <span className="text-muted-foreground/35">—</span> : <>{formatAmount(n)}</>;
  };

  const { data: stockMovementData, isLoading: stockMovementLoading } = useQuery<StockMovementResponse>({
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

  const { data: smDrillData, isLoading: smDrillLoading } = useQuery<StockMovementDrillResponse>({
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

  const monthlyRows = stockMovementData?.months ?? [];
  const isAllTime = stockMovementPeriod.preset === "all_time";
  const smRowsWithYear = isAllTime
    ? monthlyRows.filter((month) => {
        const inwardQty = Math.abs(toSafeNumber(month.inwardQty));
        const outwardQty = Math.abs(toSafeNumber(month.outwardQty));
        const openingQty = toSafeNumber(month.openingQty);
        const closingQty = toSafeNumber(month.closingQty);
        const openingValue = toSafeNumber(month.openingValue);
        const closingValue = toSafeNumber(month.closingValue);

        return (
          inwardQty > MOVEMENT_EPSILON ||
          outwardQty > MOVEMENT_EPSILON ||
          Math.abs(closingQty - openingQty) > MOVEMENT_EPSILON ||
          Math.abs(closingValue - openingValue) > MOVEMENT_EPSILON
        );
      })
    : monthlyRows;

  const numberCell = "px-4 py-3.5 text-right tabular-nums whitespace-nowrap text-[13px]";
  const mutedNumberCell = cn(numberCell, "text-muted-foreground");
  const inNumberCell = cn(numberCell, "text-emerald-600 dark:text-emerald-400");
  const outNumberCell = cn(numberCell, "text-rose-600 dark:text-rose-400");
  const closingNumberCell = cn(numberCell, "font-semibold text-blue-600 dark:text-blue-400");

  return (
    <Dialog open={stockMovementOpen} onOpenChange={setStockMovementOpen}>
      <DialogContent
        className="flex h-[88vh] w-[96vw] max-w-[1440px] flex-col gap-0 overflow-hidden rounded-2xl border border-border/60 bg-card p-0 shadow-2xl sm:max-w-[1440px] sm:p-0"
        onEscapeKeyDown={(event) => {
          if (drillMonth) {
            event.preventDefault();
            setDrillMonth(null);
          }
        }}
      >
        <DialogHeader className="flex-shrink-0 border-b border-border/60 bg-gradient-to-b from-muted/30 to-card px-5 py-5 pr-14 md:px-7 md:py-6 md:pr-16">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/15">
                <Package className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-xl font-semibold tracking-tight md:text-[22px]">
                    Stock Movement
                  </DialogTitle>
                  {drillMonth && (
                    <span className="rounded-full border border-border/60 bg-background/80 px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                      {drillMonth.monthName} {drillMonth.year}
                    </span>
                  )}
                </div>
                <DialogDescription className="mt-1 truncate text-[13px]">
                  <span className="font-medium text-foreground/80">{stockMovementItem?.stockItemName}</span>
                  <span className="mx-1.5 text-muted-foreground/50">•</span>
                  {stockMovementItem?.locationName || "All Locations"}
                </DialogDescription>
              </div>
            </div>

            {!drillMonth && (
              <div className="flex flex-col items-start gap-1.5 sm:items-end">
                <PeriodFilter value={stockMovementPeriod} onChange={setStockMovementPeriod} />
                {isAllTime && (
                  <span className="pr-1 text-[11px] text-muted-foreground">Only months with movement are shown</span>
                )}
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden bg-muted/10 p-3 md:p-5">
          <div className="h-full overflow-auto rounded-xl border border-border/60 bg-background shadow-sm scrollbar-thin">
            {drillMonth ? (
              smDrillLoading ? (
                <div className="space-y-3 p-6">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                    <Skeleton key={i} className="h-11 w-full rounded-lg" />
                  ))}
                </div>
              ) : (
                <table className="w-full border-separate border-spacing-0 text-sm" style={{ minWidth: 1240 }}>
                  <thead className="sticky top-0 z-20 shadow-[0_1px_0_0_hsl(var(--border))]">
                    <tr className="bg-muted/95 backdrop-blur">
                      <th
                        rowSpan={2}
                        className="w-24 border-r border-border/50 px-4 py-3 text-left align-bottom text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                      >
                        Date
                      </th>
                      <th
                        rowSpan={2}
                        className="min-w-[190px] border-r border-border/50 px-4 py-3 text-left align-bottom text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                      >
                        Particulars
                      </th>
                      <th
                        rowSpan={2}
                        className="w-32 border-r border-border/50 px-4 py-3 text-left align-bottom text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                      >
                        Vch Type
                      </th>
                      <th
                        colSpan={3}
                        className="border-r border-border/50 bg-emerald-500/[0.06] px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-600 dark:text-emerald-400"
                      >
                        Inward
                      </th>
                      <th
                        colSpan={3}
                        className="border-r border-border/50 bg-rose-500/[0.06] px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-rose-600 dark:text-rose-400"
                      >
                        Outward
                      </th>
                      <th
                        colSpan={3}
                        className="bg-blue-500/[0.06] px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 dark:text-blue-400"
                      >
                        Closing
                      </th>
                    </tr>
                    <tr className="bg-muted/95 text-[11px] backdrop-blur">
                      {["Qty", "Rate", "Value", "Qty", "Rate", "Value", "Qty", "Rate", "Value"].map((h, i) => (
                        <th
                          key={`${h}-${i}`}
                          className={cn(
                            "min-w-[92px] whitespace-nowrap px-4 py-2.5 text-right font-medium",
                            i < 3
                              ? "bg-emerald-500/[0.035] text-emerald-600 dark:text-emerald-400"
                              : i < 6
                                ? "bg-rose-500/[0.035] text-rose-600 dark:text-rose-400"
                                : "bg-blue-500/[0.035] text-blue-600 dark:text-blue-400",
                            i === 2 || i === 5 ? "border-r border-border/50" : ""
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
                        <td colSpan={12} className="px-6 py-20 text-center">
                          <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                              <Package className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <p className="font-medium text-foreground">No transactions found</p>
                            <p className="text-xs text-muted-foreground">
                              There are no movements for {drillMonth.monthName} {drillMonth.year}.
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}

                    {smDrillData?.transactions?.map((txn, idx: number) => {
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
                            "group border-b border-border/40 transition-colors hover:bg-muted/30",
                            txn.isOpeningBalance ? "bg-muted/25 font-medium" : "bg-background"
                          )}
                        >
                          <td className="border-r border-border/40 px-4 py-3.5 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                            {dispDate}
                          </td>
                          <td className="border-r border-border/40 px-4 py-3.5">
                            {editUrl ? (
                              <button
                                onClick={() => {
                                  window.open(editUrl, "_blank", "noopener,noreferrer");
                                }}
                                className="max-w-[260px] truncate text-left font-medium text-foreground transition-colors hover:text-primary hover:underline"
                                data-testid={`link-drill-particulars-${idx}`}
                              >
                                {txn.particulars}
                              </button>
                            ) : (
                              <div className="max-w-[260px]">
                                <span className="block truncate font-medium text-foreground">{txn.particulars}</span>
                                {txn.isOpeningBalance && (
                                  <span
                                    className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground"
                                    data-testid={`text-opening-balance-location-${idx}`}
                                  >
                                    {stockMovementItem?.locationName || "All Locations"}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="border-r border-border/40 px-4 py-3.5 text-xs text-muted-foreground whitespace-nowrap">
                            {txn.vchType}
                          </td>
                          <td className={inNumberCell}>{fmtN(txn.inwardQty, 0)}</td>
                          <td className={inNumberCell}>{fmtA(txn.inwardRate)}</td>
                          <td className={cn(inNumberCell, "border-r border-border/40")}>{fmtA(txn.inwardValue)}</td>
                          <td className={outNumberCell}>{fmtN(txn.outwardQty, 0)}</td>
                          <td className={outNumberCell}>
                            {fmtA(txn.posSellingRate ? txn.posSellingRate : txn.outwardRate)}
                          </td>
                          <td className={cn(outNumberCell, "border-r border-border/40")}>
                            {fmtA(txn.posSellingValue ? txn.posSellingValue : txn.outwardValue)}
                          </td>
                          <td className={closingNumberCell}>{fmtN(txn.closingQty, 0)}</td>
                          <td className={closingNumberCell}>{fmtA(txn.closingRate)}</td>
                          <td className={closingNumberCell}>{fmtA(txn.closingValue)}</td>
                        </tr>
                      );
                    })}

                    {smDrillData?.totals &&
                      smDrillData.transactions?.length > 0 &&
                      (() => {
                        const t = smDrillData.totals;
                        const lastTxn = smDrillData.transactions[smDrillData.transactions.length - 1];
                        return (
                          <tr className="sticky bottom-0 z-10 bg-card/95 font-semibold shadow-[0_-1px_0_0_hsl(var(--border))] backdrop-blur">
                            <td colSpan={3} className="border-r border-border/50 px-4 py-3.5 text-sm">
                              Total
                            </td>
                            <td className={inNumberCell}>{fmtN(t.inwardQty, 0)}</td>
                            <td className={inNumberCell}>{fmtA(t.inwardRate)}</td>
                            <td className={cn(inNumberCell, "border-r border-border/50")}>{fmtA(t.inwardValue)}</td>
                            <td className={outNumberCell}>{fmtN(t.outwardQty, 0)}</td>
                            <td className={outNumberCell}>{fmtA(t.outwardRate)}</td>
                            <td className={cn(outNumberCell, "border-r border-border/50")}>{fmtA(t.outwardValue)}</td>
                            <td className={closingNumberCell}>{fmtN(lastTxn.closingQty, 0)}</td>
                            <td className={closingNumberCell}>{fmtA(lastTxn.closingRate)}</td>
                            <td className={closingNumberCell}>{fmtA(lastTxn.closingValue)}</td>
                          </tr>
                        );
                      })()}
                  </tbody>
                </table>
              )
            ) : stockMovementLoading ? (
              <div className="space-y-3 p-6">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            ) : (
              <table className="w-full border-separate border-spacing-0 text-sm" style={{ minWidth: 1180 }}>
                <thead className="sticky top-0 z-20 shadow-[0_1px_0_0_hsl(var(--border))]">
                  <tr className="bg-muted/95 backdrop-blur">
                    <th
                      rowSpan={2}
                      className="w-36 border-r border-border/50 px-5 py-3 text-left align-bottom text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                    >
                      Month
                    </th>
                    <th
                      colSpan={3}
                      className="border-r border-border/50 bg-muted/35 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                    >
                      Opening
                    </th>
                    <th
                      colSpan={3}
                      className="border-r border-border/50 bg-emerald-500/[0.06] px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-600 dark:text-emerald-400"
                    >
                      Stock In
                    </th>
                    <th
                      colSpan={3}
                      className="border-r border-border/50 bg-rose-500/[0.06] px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-rose-600 dark:text-rose-400"
                    >
                      Stock Out
                    </th>
                    <th
                      colSpan={3}
                      className="bg-blue-500/[0.06] px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 dark:text-blue-400"
                    >
                      Closing
                    </th>
                  </tr>
                  <tr className="bg-muted/95 text-[11px] backdrop-blur">
                    {[
                      "Qty",
                      "Rate",
                      "Value",
                      "Qty",
                      "Rate",
                      "Value",
                      "Qty",
                      "Rate",
                      "Value",
                      "Qty",
                      "Rate",
                      "Value",
                    ].map((h, i) => (
                      <th
                        key={`${h}-${i}`}
                        className={cn(
                          "min-w-[86px] whitespace-nowrap px-4 py-2.5 text-right font-medium",
                          i < 3
                            ? "bg-muted/20 text-muted-foreground"
                            : i < 6
                              ? "bg-emerald-500/[0.035] text-emerald-600 dark:text-emerald-400"
                              : i < 9
                                ? "bg-rose-500/[0.035] text-rose-600 dark:text-rose-400"
                                : "bg-blue-500/[0.035] text-blue-600 dark:text-blue-400",
                          i === 2 || i === 5 || i === 8 ? "border-r border-border/50" : ""
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {smRowsWithYear.length === 0 && (
                    <tr>
                      <td colSpan={13} className="px-6 py-20 text-center">
                        <div className="mx-auto flex max-w-sm flex-col items-center gap-2">
                          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                            <Package className="h-4 w-4 text-muted-foreground" />
                          </div>
                          <p className="font-medium text-foreground">No stock movement for this period</p>
                          <p className="text-xs text-muted-foreground">
                            {isAllTime
                              ? "Months with no stock activity are hidden from All Time view."
                              : "Try another period to see movement history."}
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}

                  {smRowsWithYear.map((m) => {
                    const fmtQ = (n: number) =>
                      n === 0 ? (
                        <span className="text-muted-foreground/35">—</span>
                      ) : (
                        <>{n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</>
                      );
                    const fmtR = (n: number) =>
                      n === 0 ? (
                        <span className="text-muted-foreground/35">—</span>
                      ) : (
                        <>{n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
                      );
                    const fmtV = (n: number) =>
                      n === 0 ? <span className="text-muted-foreground/35">—</span> : <>{formatAmount(n)}</>;

                    return (
                      <tr
                        key={`${m.year}-${m.month}`}
                        data-testid={`row-sm-month-${m.month}`}
                        className="group cursor-pointer bg-background transition-colors hover:bg-muted/30"
                        onClick={() => setDrillMonth({ year: m.year, month: m.month, monthName: m.monthName })}
                      >
                        <td className="border-r border-t border-border/40 px-5 py-4 font-semibold whitespace-nowrap">
                          <span className="flex items-center justify-between gap-3">
                            <span>{m.monthName}</span>
                            <ChevronRight className="h-4 w-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground/70" />
                          </span>
                        </td>
                        <td className={cn(mutedNumberCell, "border-t border-border/40")}>{fmtQ(m.openingQty)}</td>
                        <td className={cn(mutedNumberCell, "border-t border-border/40")}>{fmtR(m.openingRate)}</td>
                        <td className={cn(mutedNumberCell, "border-r border-t border-border/40")}>
                          {fmtV(m.openingValue)}
                        </td>
                        <td className={cn(inNumberCell, "border-t border-border/40")}>{fmtQ(m.inwardQty)}</td>
                        <td className={cn(inNumberCell, "border-t border-border/40")}>{fmtR(m.inwardRate)}</td>
                        <td className={cn(inNumberCell, "border-r border-t border-border/40")}>
                          {fmtV(m.inwardValue)}
                        </td>
                        <td className={cn(outNumberCell, "border-t border-border/40")}>{fmtQ(m.outwardQty)}</td>
                        <td className={cn(outNumberCell, "border-t border-border/40")}>{fmtR(m.outwardRate)}</td>
                        <td className={cn(outNumberCell, "border-r border-t border-border/40")}>
                          {fmtV(m.outwardValue)}
                        </td>
                        <td className={cn(closingNumberCell, "border-t border-border/40")}>{fmtQ(m.closingQty)}</td>
                        <td className={cn(closingNumberCell, "border-t border-border/40")}>{fmtR(m.closingRate)}</td>
                        <td className={cn(closingNumberCell, "border-t border-border/40")}>{fmtV(m.closingValue)}</td>
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
                          <span className="text-muted-foreground/35">—</span>
                        ) : (
                          <>{n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</>
                        );
                      const fmtR = (n: number) =>
                        n === 0 ? (
                          <span className="text-muted-foreground/35">—</span>
                        ) : (
                          <>{n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
                        );
                      const fmtV = (n: number) =>
                        n === 0 ? <span className="text-muted-foreground/35">—</span> : <>{formatAmount(n)}</>;

                      return (
                        <tr className="sticky bottom-0 z-10 bg-card/95 font-semibold shadow-[0_-1px_0_0_hsl(var(--border))] backdrop-blur">
                          <td className="border-r border-border/50 px-5 py-4 text-sm">Total</td>
                          <td className={mutedNumberCell}>{fmtQ(smRowsWithYear[0]?.openingQty ?? 0)}</td>
                          <td className={mutedNumberCell}>{fmtR(smRowsWithYear[0]?.openingRate ?? 0)}</td>
                          <td className={cn(mutedNumberCell, "border-r border-border/50")}>
                            {fmtV(smRowsWithYear[0]?.openingValue ?? 0)}
                          </td>
                          <td className={inNumberCell}>{fmtQ(gt.inwardQty)}</td>
                          <td className={inNumberCell}>{fmtR(inRate)}</td>
                          <td className={cn(inNumberCell, "border-r border-border/50")}>{fmtV(gt.inwardValue)}</td>
                          <td className={outNumberCell}>{fmtQ(gt.outwardQty)}</td>
                          <td className={outNumberCell}>{fmtR(outRate)}</td>
                          <td className={cn(outNumberCell, "border-r border-border/50")}>{fmtV(gt.outwardValue)}</td>
                          <td className={closingNumberCell}>{fmtQ(gt.closingQty)}</td>
                          <td className={closingNumberCell}>{fmtR(clsRate)}</td>
                          <td className={closingNumberCell}>{fmtV(gt.closingValue)}</td>
                        </tr>
                      );
                    })()}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="flex flex-shrink-0 flex-col gap-3 border-t border-border/60 bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between md:px-7">
          <div className="min-h-4">
            {drillMonth && (
              <span className="text-xs text-muted-foreground">Press Esc to return to monthly summary</span>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            {drillMonth ? (
              <Button
                variant="outline"
                className="rounded-lg"
                onClick={() => setDrillMonth(null)}
                data-testid="button-sm-back-to-months"
              >
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                Back to months
              </Button>
            ) : (
              <Button
                variant="outline"
                className="rounded-lg"
                onClick={() => setStockMovementOpen(false)}
                data-testid="button-sm-close"
              >
                Close
              </Button>
            )}

            {stockMovementItem && (
              <Button
                className="rounded-lg shadow-sm"
                onClick={() => {
                  const locId = stockMovementItem.locationId;
                  const sid = stockMovementItem.stockItemId;
                  if (drillMonth) {
                    if (locId) {
                      navigate(
                        `/locations/${locId}/stock-items/${sid}/vouchers/${drillMonth.year}/${drillMonth.month}`
                      );
                    }
                  } else if (locId) {
                    navigate(`/locations/${locId}/stock-items/${sid}/history`);
                  } else {
                    navigate(`/stock-items/${sid}/monthly-summary`);
                  }
                  setDrillMonth(null);
                  setStockMovementOpen(false);
                  setStockMovementItem(null);
                }}
                data-testid="button-sm-open-full"
              >
                <ArrowRight className="mr-1.5 h-4 w-4" />
                {drillMonth ? "Open in full view" : "Open full history"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
