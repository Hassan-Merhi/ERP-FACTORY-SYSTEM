/**
 * Filterable, infinite-scroll waste dispatch history.
 * Detailed view shows bale-level records only as they enter the viewport;
 * condensed view keeps the existing on-demand expansion and print/delete.
 */
import { useEffect, useRef } from "react";
import { History, Loader2, Weight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PeriodFilter } from "@/components/ui/period-filter";
import { fmt, fmtKg } from "../utils";
import { DispatchHistoryItem, type WasteDispatchModel } from "./DispatchHistoryItem";

export function DispatchHistoryPanel({ model }: { model: WasteDispatchModel }) {
  const {
    historyItems,
    historyPagination,
    historyTotals,
    historyLoading,
    historyError,
    historyFetchError,
    historyFetchingNextPage,
    historyHasNextPage,
    fetchNextHistoryPage,
    refetchHistory,
    historyPeriod,
    setHistoryPeriod,
    historyView,
    setHistoryView,
  } = model;
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // The sentinel follows the outer page's scroll container (no separate history
  // scrollbar). It starts the next page only when the bottom comes into view.
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !historyHasNextPage || historyFetchingNextPage || historyError) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          void fetchNextHistoryPage();
        }
      },
      { rootMargin: "350px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [historyItems.length, historyHasNextPage, historyFetchingNextPage, historyError, fetchNextHistoryPage]);

  const hasDateFilter = historyPeriod.preset !== "all_time";

  return (
    <Card className="overflow-hidden rounded-2xl border-slate-200 bg-white shadow-sm dark:border-slate-700/70 dark:bg-slate-900/80">
      <CardHeader className="space-y-4 border-b border-slate-200 px-4 pb-4 pt-4 dark:border-slate-700/70 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base font-bold tracking-tight sm:text-lg">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400">
              <History className="h-5 w-5" />
            </span>{" "}
            Dispatch History
          </CardTitle>
          <span
            className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
            data-testid="text-dispatch-history-count"
          >
            {historyPagination.total} dispatch{historyPagination.total !== 1 ? "es" : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            className="flex gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-950/30"
            aria-label="History display mode"
          >
            <Button
              size="sm"
              variant={historyView === "condensed" ? "secondary" : "ghost"}
              className="h-8 px-3 text-xs"
              aria-pressed={historyView === "condensed"}
              onClick={() => setHistoryView("condensed")}
              data-testid="button-history-condensed"
            >
              Condensed
            </Button>
            <Button
              size="sm"
              variant={historyView === "detailed" ? "secondary" : "ghost"}
              className="h-8 px-3 text-xs"
              aria-pressed={historyView === "detailed"}
              onClick={() => setHistoryView("detailed")}
              data-testid="button-history-detailed"
            >
              Detailed
            </Button>
          </div>
          {/* Use the exact Analytics period dropdown and two-date custom calendar. */}
          <PeriodFilter
            value={historyPeriod}
            onChange={setHistoryPeriod}
            data-testid="period-filter-dispatch-history"
          />
        </div>
        <div
          className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 dark:border-slate-700 dark:bg-slate-950/40 sm:grid-cols-3 sm:p-4"
          data-testid="bar-history-totals"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Total Qty (Bales)</span>
            <span className="text-base font-semibold tabular-nums" data-testid="text-history-total-bales">
              {historyTotals.bales.toLocaleString("en-US")}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Weight className="h-3 w-3" /> Total KG
            </span>
            <span className="text-base font-semibold tabular-nums" data-testid="text-history-total-kg">
              {fmtKg(historyTotals.weightKg)} kg
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Total Amount (Written Off)</span>
            <span className="text-base font-semibold tabular-nums" data-testid="text-history-total-amount">
              {fmt(historyTotals.amount)}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {historyLoading && !historyItems.length ? (
          <div className="flex justify-center py-8" aria-label="Loading dispatches">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : !historyItems.length && !historyError ? (
          <p className="p-4 text-sm text-muted-foreground">
            {hasDateFilter ? "No dispatches in the selected date range." : "No dispatches yet."}
          </p>
        ) : (
          <div className="divide-y divide-slate-200 dark:divide-slate-700/70">
            {historyItems.map((dispatch) => (
              <DispatchHistoryItem key={dispatch.id} model={model} dispatch={dispatch} />
            ))}
          </div>
        )}
        {historyError && (
          <div className="flex flex-wrap items-center justify-center gap-2 border-t px-4 py-3 text-xs text-destructive">
            <span>
              {historyFetchError instanceof Error ? historyFetchError.message : "Unable to load dispatch history."}
            </span>
            <Button variant="outline" size="sm" onClick={() => void refetchHistory()}>
              Retry
            </Button>
          </div>
        )}
        {historyFetchingNextPage && (
          <div className="flex items-center justify-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading more dispatches...
          </div>
        )}
        <div ref={loadMoreRef} className="h-1" aria-hidden="true" data-testid="sentinel-history-load-more" />
        {!historyHasNextPage && !historyLoading && historyItems.length > 0 && (
          <p className="border-t px-4 py-2 text-center text-xs text-muted-foreground">
            All {historyPagination.total} dispatches loaded
          </p>
        )}
      </CardContent>
    </Card>
  );
}
