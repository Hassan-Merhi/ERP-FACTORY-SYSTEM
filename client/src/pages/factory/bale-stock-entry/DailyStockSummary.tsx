import { useQuery } from "@tanstack/react-query";
import { Factory } from "lucide-react";

export function formatDailyNum(val: number): string {
  if (val === 0) return "0";
  return val % 1 === 0 ? val.toFixed(0) : parseFloat(val.toFixed(3)).toString();
}

export interface DailyStockSummaryRow {
  category?: string | null;
  count?: number | string | null;
  totalKg?: number | string | null;
}

export function normalizeDailySummaryRows(payload: unknown): DailyStockSummaryRow[] {
  if (Array.isArray(payload)) return payload as DailyStockSummaryRow[];

  const nestedRows = payload && typeof payload === "object" ? (payload as { rows?: unknown }).rows : undefined;
  return Array.isArray(nestedRows) ? (nestedRows as DailyStockSummaryRow[]) : [];
}

export function DailyStockSummary({ date }: { date: string }) {
  const todayStr = new Date().toLocaleDateString("en-CA");

  const { data: summaryRows = [] } = useQuery<DailyStockSummaryRow[]>({
    queryKey: ["/api/factory/bales/daily-summary", date],
    queryFn: async () => {
      const response = await fetch(`/api/factory/bales/daily-summary?date=${date}`, {
        credentials: "include",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "message" in payload
            ? String((payload as { message?: unknown }).message || "Failed to load daily production summary")
            : "Failed to load daily production summary";
        throw new Error(message);
      }
      return normalizeDailySummaryRows(payload);
    },
    staleTime: 30000,
  });

  let totalQty = 0,
    totalKg = 0;
  let garbageQty = 0,
    garbageKg = 0;
  let wipersQty = 0,
    wipersKg = 0;

  for (const row of normalizeDailySummaryRows(summaryRows)) {
    const cat = (row.category || "").toLowerCase().trim();
    const qty = Number(row.count || 0);
    const kg = parseFloat(String(row.totalKg || "0"));
    if (cat === "garbage") {
      garbageQty += qty;
      garbageKg += kg;
    } else if (cat === "wipers") {
      wipersQty += qty;
      wipersKg += kg;
    } else {
      totalQty += qty;
      totalKg += kg;
    }
  }

  const isToday = date === todayStr;

  return (
    <section
      aria-label={isToday ? "Today's factory production" : "Factory production summary"}
      data-factory-daily-summary="true"
      className="grid min-w-0 grid-cols-1 gap-2 min-[420px]:grid-cols-2 lg:grid-cols-4"
    >
      <div className="flex min-h-11 items-center rounded-lg border border-dashed px-3 py-2">
        <span className="break-words text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {isToday ? "Today" : "Production"}
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
        <Factory className="h-4 w-4 shrink-0 text-emerald-500" />
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span
            className="text-base font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
            data-testid="text-entry-today-qty"
          >
            {totalQty}
          </span>
          <span className="text-xs text-emerald-600/70 dark:text-emerald-400/70">bales</span>
          <span className="text-muted-foreground" aria-hidden="true">
            ·
          </span>
          <span
            className="text-base font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
            data-testid="text-entry-today-kg"
          >
            {formatDailyNum(totalKg)}
          </span>
          <span className="text-xs text-emerald-600/70 dark:text-emerald-400/70">kg</span>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-orange-500/20 bg-orange-500/10 px-3 py-2">
        <span className="shrink-0 text-xs font-semibold text-orange-500">Garbage</span>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span
            className="text-base font-bold tabular-nums text-orange-600 dark:text-orange-400"
            data-testid="text-entry-today-garbage-qty"
          >
            {garbageQty}
          </span>
          <span className="text-xs text-orange-600/70 dark:text-orange-400/70">bales</span>
          <span className="text-muted-foreground" aria-hidden="true">
            ·
          </span>
          <span
            className="text-base font-bold tabular-nums text-orange-600 dark:text-orange-400"
            data-testid="text-entry-today-garbage-kg"
          >
            {formatDailyNum(garbageKg)}
          </span>
          <span className="text-xs text-orange-600/70 dark:text-orange-400/70">kg</span>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2">
        <span className="shrink-0 text-xs font-semibold text-blue-500">Wipers</span>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span
            className="text-base font-bold tabular-nums text-blue-600 dark:text-blue-400"
            data-testid="text-entry-today-wipers-qty"
          >
            {wipersQty}
          </span>
          <span className="text-xs text-blue-600/70 dark:text-blue-400/70">bales</span>
          <span className="text-muted-foreground" aria-hidden="true">
            ·
          </span>
          <span
            className="text-base font-bold tabular-nums text-blue-600 dark:text-blue-400"
            data-testid="text-entry-today-wipers-kg"
          >
            {formatDailyNum(wipersKg)}
          </span>
          <span className="text-xs text-blue-600/70 dark:text-blue-400/70">kg</span>
        </div>
      </div>
    </section>
  );
}
