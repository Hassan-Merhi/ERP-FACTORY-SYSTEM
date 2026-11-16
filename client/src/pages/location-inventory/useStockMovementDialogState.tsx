// Extracted from ./StockMovementDialog.tsx to keep that module under the source-size cap.
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import type {
  StockMovementDrillResponse,
  StockMovementItem,
  StockMovementMonth,
  StockMovementPeriod,
  StockMovementResponse,
} from "./locationInventoryTypes";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";

export interface StockMovementDialogProps {
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

export function useStockMovementDialogState({
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
  const mobileCards = useMobileCardTable();
  const mobileCardsSecondary = useMobileCardTable();
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
  return {
    closingNumberCell,
    drillMonth,
    fmtA,
    fmtN,
    formatAmount,
    inNumberCell,
    isAllTime,
    mobileCards,
    mobileCardsSecondary,
    mutedNumberCell,
    navigate,
    outNumberCell,
    setDrillMonth,
    setStockMovementItem,
    setStockMovementOpen,
    setStockMovementPeriod,
    smDrillData,
    smDrillLoading,
    smRowsWithYear,
    stockMovementData,
    stockMovementItem,
    stockMovementLoading,
    stockMovementOpen,
    stockMovementPeriod,
  };
}

export function StockMovementDialogSection() {
  return (
    <thead className="sticky top-0 z-20 shadow-[0_1px_0_0_hsl(var(--border))]">
      <tr className="bg-muted/95 backdrop-blur-sm">
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
          className="border-r border-border/50 bg-emerald-500/6 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-600 dark:text-emerald-400"
        >
          Inward
        </th>
        <th
          colSpan={3}
          className="border-r border-border/50 bg-rose-500/6 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-rose-600 dark:text-rose-400"
        >
          Outward
        </th>
        <th
          colSpan={3}
          className="bg-blue-500/6 px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-600 dark:text-blue-400"
        >
          Closing
        </th>
      </tr>
      <tr className="bg-muted/95 text-[11px] backdrop-blur-sm">
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
  );
}
