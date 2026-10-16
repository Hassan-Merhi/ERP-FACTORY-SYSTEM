/**
 * Filterable, infinite-scroll waste dispatch history.
 * Detailed view shows bale-level records only as they enter the viewport;
 * condensed view keeps the existing on-demand expansion and print/delete.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, History, Loader2, Printer, Trash2, Weight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PeriodFilter } from "@/components/ui/period-filter";
import { fetchHistoryBales } from "../optimizedData";
import { fmt, fmtKg } from "../utils";
import type { useWasteDispatchModel } from "../useWasteDispatchModel";
import type { HistoryBale } from "../optimizedTypes";

type WasteDispatchModel = ReturnType<typeof useWasteDispatchModel>;

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
    <Card>
      <CardHeader className="space-y-3 px-4 pb-3 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-muted-foreground" /> Dispatch History
          </CardTitle>
          <span className="text-xs text-muted-foreground" data-testid="text-dispatch-history-count">
            {historyPagination.total} dispatch{historyPagination.total !== 1 ? "es" : ""}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1 rounded-md border p-0.5" aria-label="History display mode">
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
        <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-3" data-testid="bar-history-totals">
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
          <div className="divide-y">
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

function DispatchHistoryItem({
  model,
  dispatch,
}: {
  model: WasteDispatchModel;
  dispatch: WasteDispatchModel["historyItems"][number];
}) {
  const { expandedHistoryIds, toggleHistoryItem, handleHistoryPrint, setDeleteDispatchId, historyView } = model;
  const isDetailed = historyView === "detailed";
  const isOpen = isDetailed || expandedHistoryIds.has(dispatch.id);
  const itemRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);

  // Don't download bale details for history records well below the user's scroll
  // position. The detail query remains cached for condensed expand/reprint.
  useEffect(() => {
    const node = itemRef.current;
    if (!node || !isOpen || nearViewport) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "250px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [isOpen, nearViewport]);

  const detailQuery = useQuery<HistoryBale[]>({
    queryKey: ["/api/factory/waste-dispatch/history-bales", dispatch.id],
    queryFn: () => fetchHistoryBales(dispatch.id),
    enabled: isOpen && nearViewport,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const bales = detailQuery.data ?? [];

  return (
    <div ref={itemRef}>
      <div
        className={`flex flex-wrap items-center justify-between gap-2 px-4 hover:bg-muted/30 ${isDetailed ? "py-3" : "py-2.5 cursor-pointer"}`}
        onClick={() => {
          if (!isDetailed) toggleHistoryItem(dispatch.id);
        }}
        data-testid={`row-dispatch-${dispatch.id}`}
        aria-expanded={isOpen}
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
          />
          <div>
            <p className="text-xs font-semibold">{dispatch.dispatchNumber}</p>
            <p className="text-xs text-muted-foreground">{dispatch.dispatchDate}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-muted-foreground">
            {dispatch.totalBales} bale{dispatch.totalBales !== 1 ? "s" : ""}
          </span>
          <span className="text-muted-foreground">{fmtKg(dispatch.totalWeightKg)} kg</span>
          <Badge variant="outline" className="border-destructive/30 text-xs text-destructive">
            {fmt(dispatch.totalCostWrittenOff)}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              void handleHistoryPrint(dispatch);
            }}
            data-testid={`button-reprint-${dispatch.id}`}
          >
            <Printer className="mr-1 h-3 w-3" /> Print
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-destructive hover:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              setDeleteDispatchId(dispatch.id);
            }}
            data-testid={`button-delete-dispatch-${dispatch.id}`}
          >
            <Trash2 className="mr-1 h-3 w-3" /> Delete
          </Button>
        </div>
      </div>
      {isOpen && (
        <div className="bg-muted/30 px-4 pb-4 pt-2">
          {dispatch.notes && (
            <p className="mb-2 text-xs text-muted-foreground">
              <span className="font-medium">Note:</span> {dispatch.notes}
            </p>
          )}
          {!nearViewport || detailQuery.isLoading || detailQuery.isPending ? (
            <div className="py-4 text-center" aria-label="Loading bale details">
              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
            </div>
          ) : detailQuery.isError ? (
            <div className="flex items-center gap-2 text-xs text-destructive">
              Could not load bale details.
              <Button variant="outline" size="sm" onClick={() => void detailQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : bales.length === 0 ? (
            <p className="text-xs text-muted-foreground">No bale details available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="mt-1 w-full min-w-[420px] border-collapse text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="py-1.5 text-left">Reference</th>
                    <th className="py-1.5 text-left">Product</th>
                    <th className="py-1.5 text-right">Weight (kg)</th>
                    <th className="py-1.5 text-right">Cost W/O</th>
                  </tr>
                </thead>
                <tbody>
                  {bales.map((bale) => (
                    <tr key={bale.id} className="border-b border-border/40 last:border-0">
                      <td className="py-1 font-mono text-primary">{bale.referenceNumber}</td>
                      <td className="py-1">{bale.productName}</td>
                      <td className="py-1 text-right">{fmtKg(Number(bale.weightKg || 0))}</td>
                      <td className="py-1 text-right">{fmt(Number(bale.totalCost || 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
