// Extracted from ./DispatchHistoryPanel.tsx
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Loader2, Trash2 } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchHistoryBales } from "../optimizedData";
import { fmt, fmtKg } from "../utils";
import type { useWasteDispatchModel } from "../useWasteDispatchModel";
import type { HistoryBale } from "../optimizedTypes";

export type WasteDispatchModel = ReturnType<typeof useWasteDispatchModel>;

export function DispatchHistoryItem({
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
        className={`flex flex-wrap items-center justify-between gap-2 px-4 transition-colors hover:bg-orange-50/60 dark:hover:bg-slate-800/65 ${isDetailed ? "py-3" : "py-2.5 cursor-pointer"}`}
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
          <ExportButton
            kind="print"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              void handleHistoryPrint(dispatch);
            }}
            data-testid={`button-reprint-${dispatch.id}`}
          />
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
        <div className="bg-slate-50/80 px-4 pb-4 pt-2 dark:bg-slate-950/35">
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
