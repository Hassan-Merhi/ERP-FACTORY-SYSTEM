import { CheckCircle2, RefreshCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";

import { useRawStockRecalculate } from "../useRawStockRecalculate";

interface RawStockPartialFixPanelProps {
  rawStock: ReturnType<typeof useRawStockRecalculate>;
}

export function RawStockPartialFixPanel({ rawStock }: RawStockPartialFixPanelProps) {
  const {
    wrapAdminAction,
    activeTab,
    partialOffloadScan,
    partialOffloadLoading,
    refetchPartialOffload,
    partialOffloadApplyMutation,
  } = rawStock;

  return (
    <>
      {/* ── Tab: Partial Offload Fix ──────────────────────────────────────── */}
      {activeTab === "partialfix" && (
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold leading-tight">Partial Offload Legacy Cost Fix</h2>
            <p className="text-xs text-muted-foreground leading-tight max-w-2xl">
              Finds containers that were partially received and whose stored cost/kg was calculated using the old wrong
              formula (supplier rate only, ignoring freight + commission + other charges). Applies the correct formula:{" "}
              <span className="font-mono">total landed cost ÷ actual received kg</span>.
            </p>
          </div>

          {partialOffloadLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !partialOffloadScan ? (
            <div className="text-xs text-muted-foreground py-6 text-center border rounded-md bg-card">
              Loading scan…
            </div>
          ) : partialOffloadScan.affected.length === 0 ? (
            <div className="space-y-2">
              <div className="text-xs text-emerald-600 py-6 text-center border border-emerald-500/30 rounded-md bg-emerald-500/5">
                ✓ No partial-offload cost errors found across {partialOffloadScan.totalScanned} container(s).
              </div>
              {partialOffloadScan.skippedFx.length > 0 && (
                <div className="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
                  {partialOffloadScan.skippedFx.length} container(s) skipped — unresolved FX rate. Set their FX rate
                  then re-scan.
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
                Found <strong>{partialOffloadScan.affected.length}</strong> container(s) with incorrect partial-offload
                costs out of {partialOffloadScan.totalScanned} scanned.
                {partialOffloadScan.skippedFx.length > 0 &&
                  ` (${partialOffloadScan.skippedFx.length} additional skipped — unresolved FX rate)`}
              </div>

              <div className="border rounded-md overflow-hidden bg-card shadow-sm">
                <Table mobileLayout="cards">
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Container</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Received kg</TableHead>
                      <TableHead className="text-right">Old $/kg</TableHead>
                      <TableHead className="text-right">Correct $/kg</TableHead>
                      <TableHead className="text-right">Diff %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {partialOffloadScan.affected.map((r) => (
                      <TableRow key={r.containerId}>
                        <TableCell className="font-mono text-xs">{r.containerNumber}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{r.supplierName || "—"}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            {r.containerStatus}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">{formatNumber(r.receivedKg)}</TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          ${r.old.costPerKgUsd.toFixed(6)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium text-emerald-600">
                          ${r.next.costPerKgUsd.toFixed(6)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline" className="text-red-500 border-red-500/30 bg-red-500/10 text-[10px]">
                            {r.diffPct > 0 ? "+" : ""}
                            {r.diffPct.toFixed(1)}%
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => refetchPartialOffload()}
                  disabled={partialOffloadLoading}
                  className="gap-2"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Re-scan
                </Button>
                <Button
                  size="sm"
                  disabled={partialOffloadApplyMutation.isPending}
                  onClick={() =>
                    wrapAdminAction(
                      () => partialOffloadApplyMutation.mutate(),
                      `Apply corrected landed cost to ${partialOffloadScan.affected.length} partial-offload container(s) — rewrites mix-batch sources and bale costs`
                    )
                  }
                  className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {partialOffloadApplyMutation.isPending
                    ? "Applying…"
                    : `Fix All (${partialOffloadScan.affected.length})`}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
