/**
 * "Dispatch History" card for the Waste Dispatch page: the paged list of
 * past dispatches with expandable per-dispatch bale details, reprint, and
 * delete actions.
 *
 * Extracted from WasteDispatchOptimized.tsx during the P1 god-file split.
 * Purely presentational — all queries and mutations come from
 * useWasteDispatchModel.
 */

import { ChevronLeft, ChevronRight, History, Loader2, Printer, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmt, fmtKg } from "../utils";
import type { useWasteDispatchModel } from "../useWasteDispatchModel";
import type { HistoryBale } from "../optimizedTypes";

type WasteDispatchModel = ReturnType<typeof useWasteDispatchModel>;

export function DispatchHistoryPanel({ model }: { model: WasteDispatchModel }) {
  const { historyPage, setHistoryPage, historyLoading, historyItems, historyPagination } = model;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 pb-2 pt-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <History className="h-4 w-4 text-muted-foreground" /> Dispatch History
        </CardTitle>
        <span className="text-xs text-muted-foreground">
          {historyPagination.total} dispatch{historyPagination.total !== 1 ? "es" : ""}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {historyLoading && !historyItems.length ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : historyItems.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No dispatches yet.</p>
        ) : (
          <>
            <div className="divide-y">
              {historyItems.map((dispatch) => (
                <DispatchHistoryItem key={dispatch.id} model={model} dispatch={dispatch} />
              ))}
            </div>

            <div className="flex items-center justify-between border-t px-4 py-2">
              <span className="text-xs text-muted-foreground">
                Page {historyPagination.page} of {historyPagination.totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  disabled={historyPage <= 1}
                  onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  disabled={historyPage >= historyPagination.totalPages}
                  onClick={() => setHistoryPage((page) => Math.min(historyPagination.totalPages, page + 1))}
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
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
  const { expandedHistoryIds, toggleHistoryItem, handleHistoryPrint, setDeleteDispatchId, historyQueryById } = model;

  const isOpen = expandedHistoryIds.has(dispatch.id);
  const detailQuery = historyQueryById.get(dispatch.id);
  const bales = (detailQuery?.data as HistoryBale[] | undefined) ?? [];

  return (
    <div>
      <div
        className="flex cursor-pointer items-center justify-between px-4 py-2.5 hover:bg-muted/30"
        onClick={() => toggleHistoryItem(dispatch.id)}
        data-testid={`row-dispatch-${dispatch.id}`}
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
        <div className="flex items-center gap-3 text-xs">
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
          {detailQuery?.isLoading ? (
            <div className="py-4 text-center">
              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
            </div>
          ) : detailQuery?.isError ? (
            <p className="text-xs text-destructive">Could not load bale details.</p>
          ) : bales.length === 0 ? (
            <p className="text-xs text-muted-foreground">No bale details available.</p>
          ) : (
            <table className="mt-1 w-full border-collapse text-xs">
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
          )}
        </div>
      )}
    </div>
  );
}
