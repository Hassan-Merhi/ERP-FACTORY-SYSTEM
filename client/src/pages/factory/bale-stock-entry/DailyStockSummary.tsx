import { useQuery } from "@tanstack/react-query";
import { Factory, Layers3, Trash2 } from "lucide-react";

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
    <section aria-label={isToday ? "Today's factory production" : "Factory production summary"}
      data-factory-daily-summary="true" className="min-w-0 space-y-2">
      <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {isToday ? "Today" : "Production"}
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
        <div className="flex min-w-0 items-center justify-between gap-4 rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/15 via-card to-card p-4 shadow-sm">
          <div className="flex min-w-0 items-center gap-3">
            <span className="rounded-xl bg-emerald-500/15 p-3 text-emerald-500"><Factory className="h-5 w-5" /></span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <strong data-testid="text-entry-today-qty" className="text-2xl font-extrabold tabular-nums">{totalQty}</strong>
                <span className="text-xs text-muted-foreground">Total bales</span>
              </div>
              <span className="text-xs text-muted-foreground">Produced bales</span>
            </div>
          </div>
          <div className="shrink-0 border-l border-emerald-500/20 pl-4 text-right">
            <strong data-testid="text-entry-today-kg" className="block text-xl font-extrabold tabular-nums text-emerald-600 dark:text-emerald-300">{formatDailyNum(totalKg)} <span className="text-xs">KG</span></strong>
            <span className="text-[11px] text-muted-foreground">Total weight</span>
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-4 rounded-2xl border border-amber-500/25 bg-gradient-to-br from-amber-500/15 via-card to-card p-4 shadow-sm">
          <div className="flex min-w-0 items-center gap-3">
            <span className="rounded-xl bg-amber-500/15 p-3 text-amber-500"><Trash2 className="h-5 w-5" /></span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <strong data-testid="text-entry-today-garbage-qty" className="text-2xl font-extrabold tabular-nums text-amber-600 dark:text-amber-300">{garbageQty}</strong>
                <span className="text-xs text-muted-foreground">bales</span>
              </div>
              <span className="text-xs text-muted-foreground">Garbage</span>
            </div>
          </div>
          <div className="shrink-0 border-l border-amber-500/20 pl-4 text-right">
            <strong data-testid="text-entry-today-garbage-kg" className="block text-xl font-extrabold tabular-nums text-amber-600 dark:text-amber-300">{formatDailyNum(garbageKg)} <span className="text-xs">KG</span></strong>
            <span className="text-[11px] text-muted-foreground">Total weight</span>
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-4 rounded-2xl border border-sky-500/25 bg-gradient-to-br from-sky-500/15 via-card to-card p-4 shadow-sm">
          <div className="flex min-w-0 items-center gap-3">
            <span className="rounded-xl bg-sky-500/15 p-3 text-sky-500"><Layers3 className="h-5 w-5" /></span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <strong data-testid="text-entry-today-wipers-qty" className="text-2xl font-extrabold tabular-nums text-sky-600 dark:text-sky-300">{wipersQty}</strong>
                <span className="text-xs text-muted-foreground">bales</span>
              </div>
              <span className="text-xs text-muted-foreground">Wipers</span>
            </div>
          </div>
          <div className="shrink-0 border-l border-sky-500/20 pl-4 text-right">
            <strong data-testid="text-entry-today-wipers-kg" className="block text-xl font-extrabold tabular-nums text-sky-600 dark:text-sky-300">{formatDailyNum(wipersKg)} <span className="text-xs">KG</span></strong>
            <span className="text-[11px] text-muted-foreground">Total weight</span>
          </div>
        </div>
      </div>
    </section>
  );
}
