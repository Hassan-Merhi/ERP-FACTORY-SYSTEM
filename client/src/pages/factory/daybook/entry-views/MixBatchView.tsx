/**
 * MIX_BATCH_CREATED / MIX_BATCH_TOPUP detail view: sources and resulting batch.
 *
 * Extracted from ViewEntryModal, where it was an early-return branch. The
 * branch declared no hooks, so this is a straight move behind a props
 * boundary rather than a behavioural change.
 */
import { DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatNumber } from "@/lib/formatNumber";
import type { DaybookEntry, DisplayDate, MixBatchDetail, MixBatchSource, Navigate } from "./types";

export function MixBatchView({
  entry,
  mixBatchDetail,
  onClose,
  formatDisplayDate,
  mixBatchSources,
  onNavigate,
}: {
  entry: DaybookEntry;
  mixBatchDetail: MixBatchDetail | null | undefined;
  onClose: () => void;
  formatDisplayDate: DisplayDate;
  mixBatchSources: MixBatchSource[];
  onNavigate: Navigate;
}) {
  const mb = mixBatchDetail;
  const totalKg = mb ? parseFloat(mb.totalWeightKg || "0") : 0;
  const totalCost = mb ? parseFloat(mb.totalCost || "0") : 0;
  const costPerKg = mb ? parseFloat(mb.costPerKg || "0") : 0;
  const sourcesTotalKg = mixBatchSources.reduce((s: number, src) => s + parseFloat(String(src.weightKg || "0")), 0);

  return (
    <>
      <DialogHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <DialogTitle>Mix Batch Details</DialogTitle>
          <Badge variant="outline" className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40">
            {entry.txType === "MIX_BATCH_TOPUP" ? "Top-up" : "Mix Batch Created"}
          </Badge>
        </div>
        <DialogDescription>{formatDisplayDate(entry.txDate + "T00:00:00")}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* Batch summary card */}
        <div className="rounded-md border p-4 space-y-3">
          {!mb ? (
            <p className="text-sm text-muted-foreground">Loading batch details…</p>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-semibold text-base font-mono">{mb.batchCode}</p>
                  {mb.name && <p className="text-sm text-muted-foreground mt-0.5">{mb.name}</p>}
                  {mb.operatorUser && (
                    <p className="text-xs text-muted-foreground mt-0.5">Operator: {mb.operatorUser}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">
                    {mb.status}
                  </Badge>
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => {
                      onClose();
                      onNavigate(`/factory/mix-batches`);
                    }}
                    data-testid="button-open-mix-batch"
                  >
                    Open
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                <div className="rounded-md bg-muted/40 px-3 py-2 text-center">
                  <p className="text-xs text-muted-foreground">Total Weight</p>
                  <p className="font-semibold font-mono">{formatNumber(totalKg)} kg</p>
                </div>
                <div className="rounded-md bg-muted/40 px-3 py-2 text-center">
                  <p className="text-xs text-muted-foreground">Total Cost</p>
                  <p className="font-semibold font-mono">${formatNumber(totalCost)}</p>
                </div>
                <div className="rounded-md bg-muted/40 px-3 py-2 text-center">
                  <p className="text-xs text-muted-foreground">Cost / kg</p>
                  <p className="font-semibold font-mono">${formatNumber(costPerKg)}</p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Sources breakdown */}
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">
            Mixed From ({mixBatchSources.length} source{mixBatchSources.length !== 1 ? "s" : ""}
            {sourcesTotalKg > 0 ? ` · ${formatNumber(sourcesTotalKg)} kg total` : ""})
          </p>
          {mixBatchSources.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4 rounded-md border">No source records found</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b">
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Source
                    </th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Weight
                    </th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      $/kg
                    </th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {mixBatchSources.map((src, i: number) => {
                    const srcKg = parseFloat(src.weightKg || "0");
                    const srcCpk = parseFloat(src.costPerKg || "0");
                    const srcTotal = parseFloat(src.totalCost || "0");
                    const pct = sourcesTotalKg > 0 ? (srcKg / sourcesTotalKg) * 100 : 0;

                    let sourceLabel: string;
                    let sourceSubLabel = "";
                    if (src.sourceType === "batch" && src.sourceBatchCode) {
                      sourceLabel = src.sourceBatchCode;
                      sourceSubLabel = "Carry-forward batch";
                    } else if (src.supplierName) {
                      sourceLabel = src.supplierName;
                      sourceSubLabel = src.containerNumber ? `Container: ${src.containerNumber}` : "";
                    } else if (src.containerNumber) {
                      sourceLabel = src.containerNumber;
                    } else {
                      sourceLabel = `Source #${src.id}`;
                    }

                    return (
                      <tr key={src.id ?? i} className="border-b last:border-0">
                        <td className="px-3 py-2.5">
                          <p className="font-medium">{sourceLabel}</p>
                          {sourceSubLabel && <p className="text-xs text-muted-foreground mt-0.5">{sourceSubLabel}</p>}
                          <p className="text-xs text-muted-foreground mt-0.5">{pct.toFixed(1)}% of batch</p>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono">{formatNumber(srcKg)} kg</td>
                        <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">
                          ${formatNumber(srcCpk)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono font-medium">${formatNumber(srcTotal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                {mixBatchSources.length > 1 && (
                  <tfoot>
                    <tr className="bg-muted/30 border-t">
                      <td className="px-3 py-2 text-xs font-medium text-muted-foreground">Total</td>
                      <td className="px-3 py-2 text-right font-mono font-medium">{formatNumber(sourcesTotalKg)} kg</td>
                      <td />
                      <td className="px-3 py-2 text-right font-mono font-medium">
                        $
                        {formatNumber(
                          mixBatchSources.reduce((s: number, src) => s + parseFloat(String(src.totalCost || "0")), 0)
                        )}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
