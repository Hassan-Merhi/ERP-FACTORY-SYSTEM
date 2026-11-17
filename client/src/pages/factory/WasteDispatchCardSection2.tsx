// Extracted from ./WasteDispatch.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, History, Trash2 } from "lucide-react";
import type { WasteDispatchHistoryBale } from "./wastedispatch/types";
import { fmt, fmtKg } from "./wastedispatch/utils";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { useWasteDispatchState } from "./useWasteDispatchState";
import { EmptyState } from "@/components/ui/page-state";

export function WasteDispatchCardSection2({
  expandedHistoryIds,
  handleHistoryPrint,
  history,
  setDeleteDispatchId,
  setShowAllHistory,
  showAllHistory,
  toggleHistoryItem,
}: Pick<
  ReturnType<typeof useWasteDispatchState>,
  | "expandedHistoryIds"
  | "handleHistoryPrint"
  | "history"
  | "setDeleteDispatchId"
  | "setShowAllHistory"
  | "showAllHistory"
  | "toggleHistoryItem"
>) {
  return (
    <Card>
      <CardHeader className="pb-2 px-4 pt-3 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <History className="w-4 h-4 text-muted-foreground" />
          Dispatch History
        </CardTitle>
        {history.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {history.length} dispatch{history.length !== 1 ? "es" : ""}
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {history.length === 0 ? (
          <EmptyState title="No dispatches yet." className="rounded-none border-0" />
        ) : (
          <div className="divide-y">
            {(showAllHistory ? history : history.slice(0, 10)).map((d) => {
              const isOpen = expandedHistoryIds.has(d.id);
              const dispatchBales = d.bales || [];
              return (
                <div key={d.id}>
                  <div
                    className="flex items-center justify-between px-4 py-2.5 hover-elevate cursor-pointer"
                    onClick={() => toggleHistoryItem(d.id)}
                    data-testid={`row-dispatch-${d.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <ChevronRight
                        className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-90" : ""}`}
                      />
                      <div>
                        <p className="font-semibold text-xs">{d.dispatchNumber}</p>
                        <p className="text-xs text-muted-foreground">{d.dispatchDate}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-muted-foreground">
                        {d.totalBales} bale{d.totalBales !== 1 ? "s" : ""}
                      </span>
                      <span className="text-muted-foreground">
                        {fmtKg(parseFloat(String(d.totalWeightKg || "0")))} kg
                      </span>
                      <Badge variant="outline" className="text-destructive border-destructive/30 text-xs">
                        {fmt(parseFloat(String(d.totalCostWrittenOff || "0")))}
                      </Badge>
                      <ExportButton
                        kind="print"
                        size="sm"
                        variant="ghost"
                        className="gap-1 h-6 px-2 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleHistoryPrint(d);
                        }}
                        data-testid={`button-reprint-${d.id}`}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1 h-6 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteDispatchId(d.id);
                        }}
                        data-testid={`button-delete-dispatch-${d.id}`}
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete
                      </Button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="bg-muted/30 px-4 pb-4 pt-1">
                      {d.notes && (
                        <p className="text-xs text-muted-foreground mb-2">
                          <span className="font-medium">Note:</span> {d.notes}
                        </p>
                      )}
                      {dispatchBales.length > 0 ? (
                        <table className="w-full text-xs mt-1 border-collapse">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left py-1.5 font-semibold text-muted-foreground">Reference</th>
                              <th className="text-left py-1.5 font-semibold text-muted-foreground">Product</th>
                              <th className="text-right py-1.5 font-semibold text-muted-foreground">Weight (kg)</th>
                              <th className="text-right py-1.5 font-semibold text-muted-foreground">Cost W/O</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dispatchBales.map((b: WasteDispatchHistoryBale) => (
                              <tr key={b.id} className="border-b border-border/40 last:border-0">
                                <td className="py-1 font-mono text-primary">{b.referenceNumber}</td>
                                <td className="py-1">{b.productName}</td>
                                <td className="py-1 text-right">{fmtKg(parseFloat(String(b.weightKg || "0")))}</td>
                                <td className="py-1 text-right">{fmt(parseFloat(String(b.totalCost || "0")))}</td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="border-t font-semibold">
                              <td className="pt-1.5" colSpan={2}>
                                TOTAL — {dispatchBales.length} bale{dispatchBales.length !== 1 ? "s" : ""}
                              </td>
                              <td className="pt-1.5 text-right">
                                {fmtKg(
                                  dispatchBales.reduce(
                                    (s: number, b: WasteDispatchHistoryBale) => s + parseFloat(String(b.weightKg || 0)),
                                    0
                                  )
                                )}
                              </td>
                              <td className="pt-1.5 text-right text-destructive">
                                {fmt(
                                  dispatchBales.reduce(
                                    (s: number, b: WasteDispatchHistoryBale) =>
                                      s + parseFloat(String(b.totalCost || 0)),
                                    0
                                  )
                                )}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      ) : (
                        <p className="text-xs text-muted-foreground">No bale details available.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {history.length > 10 && (
              <div className="px-4 py-3 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {showAllHistory
                    ? `Showing all ${history.length} dispatches`
                    : `Showing 10 of ${history.length} dispatches`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7 px-3"
                  onClick={() => setShowAllHistory((v) => !v)}
                  data-testid="button-toggle-history"
                >
                  {showAllHistory ? "Show less" : `Show all ${history.length}`}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
