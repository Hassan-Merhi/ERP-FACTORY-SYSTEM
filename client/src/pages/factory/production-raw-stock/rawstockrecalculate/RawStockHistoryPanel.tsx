import { RefreshCw, RotateCcw, Undo2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { useRawStockRecalculate } from "../useRawStockRecalculate";

interface RawStockHistoryPanelProps {
  rawStock: ReturnType<typeof useRawStockRecalculate>;
}

export function RawStockHistoryPanel({ rawStock }: RawStockHistoryPanelProps) {
  const {
    activeTab,
    setActiveTab,
    selectedRestoreIds,
    setSelectedRestoreIds,
    undoLog,
    undoLogLoading,
    refetchUndoLog,
    rateAuditRows,
    rateAuditLoading,
    refetchRateAudit,
    restorableRows,
    undoMutation,
    handleUndo,
    restoreRatesMutation,
    handleRestoreAll,
    handleRestoreSelected,
  } = rawStock;

  return (
    <>
      {/* ── Tab: History & Undo ────────────────────────────────────────────── */}
      {activeTab === "history" && (
        <div className="space-y-6">
          {/* ── Supplier Rate Recovery ──────────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold leading-tight flex items-center gap-2">
                  <RotateCcw className="h-4 w-4 text-amber-500" />
                  Restore supplier rates from audit log
                </h2>
                <p className="text-xs text-muted-foreground leading-tight mt-0.5">
                  When "Recompute Supplier Rates" overwrites moving-average rates with all-time stable averages, the
                  original values are captured in the audit log. Restore them here — 100% accurate, no guessing. After
                  restoring, refresh "Source Cost Mismatches" to fix all affected mix-batch costs.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  refetchRateAudit();
                  refetchUndoLog();
                }}
                className="gap-2 shrink-0"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </Button>
            </div>

            {rateAuditLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : !rateAuditRows || rateAuditRows.length === 0 ? (
              <div className="text-sm text-muted-foreground py-8 text-center border rounded-md bg-card">
                No "Recompute Supplier Rates" events found in the audit log for this company.
              </div>
            ) : (
              <>
                {restorableRows.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 flex-1">
                      <strong>{restorableRows.length} supplier rate(s)</strong> were overwritten and can be restored to
                      their pre-recompute moving-average values. After restoring, go to{" "}
                      <button className="underline font-medium" onClick={() => setActiveTab("sources")}>
                        Source Cost Mismatches
                      </button>{" "}
                      and click "Fix All" to correct all affected mix-batch costs.
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {selectedRestoreIds.size > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1.5 border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                          disabled={restoreRatesMutation.isPending}
                          onClick={handleRestoreSelected}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Restore Selected ({selectedRestoreIds.size})
                        </Button>
                      )}
                      <Button
                        size="sm"
                        className="gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
                        disabled={restoreRatesMutation.isPending}
                        onClick={handleRestoreAll}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {restoreRatesMutation.isPending ? "Restoring..." : `Restore All (${restorableRows.length})`}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="border rounded-md overflow-hidden bg-card shadow-sm">
                  <Table mobileLayout="cards">
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="w-8">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5"
                            checked={
                              restorableRows.length > 0 &&
                              restorableRows.every((r) => selectedRestoreIds.has(r.supplierId))
                            }
                            onChange={(e) => {
                              if (e.target.checked)
                                setSelectedRestoreIds(new Set(restorableRows.map((r) => r.supplierId)));
                              else setSelectedRestoreIds(new Set());
                            }}
                          />
                        </TableHead>
                        <TableHead>Supplier</TableHead>
                        <TableHead className="text-right">Pre-recompute rate (restore to)</TableHead>
                        <TableHead className="text-right">Recomputed (wrong)</TableHead>
                        <TableHead className="text-right">Current rate</TableHead>
                        <TableHead>Overwritten at</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rateAuditRows.map((row) => (
                        <TableRow key={row.supplierId} className={!row.canRestore ? "opacity-50" : ""}>
                          <TableCell>
                            {row.canRestore && (
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5"
                                checked={selectedRestoreIds.has(row.supplierId)}
                                onChange={(e) => {
                                  const next = new Set(selectedRestoreIds);
                                  if (e.target.checked) next.add(row.supplierId);
                                  else next.delete(row.supplierId);
                                  setSelectedRestoreIds(next);
                                }}
                              />
                            )}
                          </TableCell>
                          <TableCell className="text-sm font-medium">{row.supplierName}</TableCell>
                          <TableCell className="text-right font-mono text-sm text-emerald-600 dark:text-emerald-400">
                            ${row.oldRate.toFixed(6)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm text-red-500">
                            ${row.recomputedRate.toFixed(6)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs text-muted-foreground">
                            ${row.currentRate.toFixed(6)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(row.overwroteAt).toLocaleString()}
                            {row.changedBy && <span className="ml-1">by {row.changedBy}</span>}
                          </TableCell>
                          <TableCell>
                            {row.canRestore ? (
                              <Badge
                                variant="outline"
                                className="text-amber-600 border-amber-500/30 bg-amber-500/10 text-[10px]"
                              >
                                Restorable
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-muted-foreground text-[10px]"
                                title="Current rate no longer matches what recompute wrote — something else changed it since."
                              >
                                Already changed
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </div>

          <div className="border-t" />

          {/* ── Recalculation undo log ──────────────────────────────────────── */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold leading-tight">Recalculation history</h2>
                <p className="text-xs text-muted-foreground leading-tight">
                  Each row is a saved snapshot of the before-state. Undo restores all affected containers, mix batches,
                  bales, and supplier locked rates atomically.
                </p>
              </div>
            </div>

            {undoLogLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : !undoLog || undoLog.length === 0 ? (
              <div className="text-sm text-muted-foreground py-12 text-center border rounded-md bg-card">
                No recalculation history yet. Apply a recalculation and it will appear here.
              </div>
            ) : (
              <div className="border rounded-md overflow-hidden bg-card shadow-sm">
                <Table mobileLayout="cards">
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Applied at</TableHead>
                      <TableHead>By</TableHead>
                      <TableHead>Containers</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {undoLog.map((row) => (
                      <TableRow key={row.id} className={row.undoneAt ? "opacity-50" : ""}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(row.appliedAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {row.username ?? `User #${row.userId ?? "?"}`}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium text-foreground">{row.description}</div>
                          {row.containerNumbers && row.containerNumbers.length > 0 && (
                            <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
                              {row.containerNumbers.slice(0, 6).join(", ")}
                              {row.containerNumbers.length > 6 && ` +${row.containerNumbers.length - 6} more`}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.undoneAt ? (
                            <Badge variant="outline" className="text-muted-foreground text-[10px]">
                              Undone {new Date(row.undoneAt).toLocaleDateString()}
                              {row.undoneByUsername ? ` by ${row.undoneByUsername}` : ""}
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-emerald-500 border-emerald-500/30 bg-emerald-500/10 text-[10px]"
                            >
                              Applied
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {!row.undoneAt && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="gap-1.5 h-7 text-xs border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
                              disabled={undoMutation.isPending}
                              onClick={() => handleUndo(row)}
                            >
                              <Undo2 className="h-3 w-3" />
                              Undo
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            <div className="text-xs text-muted-foreground bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
              <strong>Important:</strong> Undo restores the exact numerical values that were in place before the
              recalculation. If any other changes were made to the same containers between the recalculation and now
              (e.g. new charges, new offloads), those will also be reverted. Review before confirming.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
