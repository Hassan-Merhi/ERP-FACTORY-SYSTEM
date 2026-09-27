import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

interface SupplierImpact {
  supplierId: number;
  supplierName: string;
  authoritativeRemainingKg: number;
  replayRemainingKg: number;
  currentStoredRate: number;
  endingExpectedRate: number;
  currentValue: number;
  projectedValue: number;
  valueDifference: number;
}

interface GateDetails {
  unresolvedInventorySupplierSources: number;
  unclassifiedValuedAdjustments: number;
  unresolvedFx: number;
  missingDates: number;
  quantityTimelineMismatches: number;
  ambiguousEventOrdering: number;
  incompleteMixedBatchSupplierScopes: number;
  missingSupplierTimelines: number;
  blockedBatches: number;
  scanCoverageError: boolean;
}

interface FinancialImpact {
  currentRawMaterialAsset: number;
  projectedRawMaterialAsset: number;
  rawMaterialDifference: number;
  currentNetPosition: number | null;
  projectedNetPosition: number | null;
  otherLedgerEffect: number;
  completedBatchesAffected: number;
  availableBalesAffected: number;
  finalizedBalesExcluded: number;
  supplierImpacts: SupplierImpact[];
  allSafetyGatesPassed: boolean;
  safetyGateDetails: GateDetails;
}

interface UnclassifiedAdjustment {
  adjustmentId: number;
  supplierId: number;
  supplierName: string;
  date: string;
  kg: number;
  costPerKg: number;
  currencyCode: string;
  reference: string | null;
  notes: string | null;
}

interface MissingSupplierTimeline {
  supplierId: number;
  supplierName: string;
  hasRawStock: boolean;
  hasAdjustment: boolean;
  hasOwnedSource: boolean;
}

interface HistoricalReplayPreview {
  financialImpact?: FinancialImpact;
  unclassifiedAdjustmentRows?: UnclassifiedAdjustment[];
  missingSupplierTimelineRows?: MissingSupplierTimeline[];
  blockedBatches?: Array<{ batchId: number; batchCode: string; reasons: string[] }>;
}

const PREVIEW_KEY = ["/api/factory/raw-stock/recalc/historical-replay"] as const;

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function number(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

export function HistoricalReplaySafetyPanel() {
  const { toast } = useToast();
  const previewQuery = useQuery<HistoricalReplayPreview>({
    queryKey: PREVIEW_KEY,
    queryFn: async () => {
      const response = await fetch(PREVIEW_KEY[0], { credentials: "same-origin" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "Failed to load Historical Replay preview");
      return payload;
    },
    retry: false,
  });

  const classifyMutation = useMutation({
    mutationFn: async ({
      adjustmentId,
      valuationBasis,
    }: {
      adjustmentId: number;
      valuationBasis: "QUANTITY_ONLY" | "VALUED_TRANSFER" | "OPENING_BALANCE";
    }) => {
      const response = await fetch(
        `/api/factory/raw-stock/recalc/historical-replay/adjustments/${adjustmentId}/valuation-basis`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ valuationBasis }),
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "Failed to classify adjustment");
      return payload;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PREVIEW_KEY });
      toast({
        title: "Adjustment classified",
        description: "Historical Replay is recalculating its safety preview.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Classification failed", description: error.message, variant: "destructive" });
    },
  });

  if (previewQuery.isLoading) {
    return (
      <div className="mb-4 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Computing the protected Historical Replay financial preview…
      </div>
    );
  }

  if (previewQuery.isError) {
    return (
      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
        <div>
          <div className="font-medium text-red-700 dark:text-red-400">Historical Replay preview unavailable</div>
          <div className="text-xs text-red-700/80 dark:text-red-400/80">
            {(previewQuery.error as Error)?.message || "The preview could not be calculated."}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={() => previewQuery.refetch()}>
          <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  const preview = previewQuery.data;
  const impact = preview?.financialImpact;
  if (!impact) {
    return (
      <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-300">
        Financial impact is not available. Prepare and Apply must not be used until the preview returns exact values.
      </div>
    );
  }

  const gateEntries: Array<[string, number | boolean]> = [
    ["Unresolved inventory owners", impact.safetyGateDetails.unresolvedInventorySupplierSources],
    ["Unclassified valued additions", impact.safetyGateDetails.unclassifiedValuedAdjustments],
    ["Unresolved FX", impact.safetyGateDetails.unresolvedFx],
    ["Missing dates", impact.safetyGateDetails.missingDates],
    ["Quantity mismatches", impact.safetyGateDetails.quantityTimelineMismatches],
    ["Ambiguous ordering", impact.safetyGateDetails.ambiguousEventOrdering],
    ["Incomplete mixed-batch scopes", impact.safetyGateDetails.incompleteMixedBatchSupplierScopes],
    ["Missing supplier timelines", impact.safetyGateDetails.missingSupplierTimelines],
    ["Blocked batches", impact.safetyGateDetails.blockedBatches],
    ["Scan coverage error", impact.safetyGateDetails.scanCoverageError],
  ];

  return (
    <div className="mb-5 space-y-4 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 font-semibold">
            {impact.allSafetyGatesPassed ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : (
              <ShieldAlert className="h-5 w-5 text-amber-600" />
            )}
            Historical Replay — protected financial preview
          </div>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            Read-only calculation from current database records. The replay changes cost fields only; liabilities,
            vouchers, cash/bank, quantities and finalized/sold bale COGS remain outside the write scope.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={impact.allSafetyGatesPassed ? "default" : "outline"}>
            {impact.allSafetyGatesPassed ? "All safety gates passed" : "Blocked — resolve issues first"}
          </Badge>
          <Button size="sm" variant="outline" onClick={() => previewQuery.refetch()}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Current raw material", money(impact.currentRawMaterialAsset)],
          ["Projected raw material", money(impact.projectedRawMaterialAsset)],
          ["Raw-material change", money(impact.rawMaterialDifference)],
          ["Current net position", money(impact.currentNetPosition)],
          ["Projected net position", money(impact.projectedNetPosition)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-muted/20 p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-lg font-bold tabular-nums">{value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {gateEntries.map(([label, value]) => {
          const failed = typeof value === "boolean" ? value : value > 0;
          return (
            <div
              key={label}
              className={`flex items-center justify-between rounded-md border px-3 py-2 text-xs ${
                failed ? "border-amber-500/30 bg-amber-500/10" : "border-emerald-500/20 bg-emerald-500/5"
              }`}
            >
              <span>{label}</span>
              <strong>{typeof value === "boolean" ? (value ? "YES" : "NO") : value}</strong>
            </div>
          );
        })}
      </div>

      {(preview.missingSupplierTimelineRows?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <div className="mb-2 text-sm font-semibold text-red-700 dark:text-red-400">
            Suppliers with raw-material evidence but no replay timeline
          </div>
          <div className="space-y-1 text-xs">
            {preview.missingSupplierTimelineRows?.map((row) => (
              <div
                key={row.supplierId}
                className="flex flex-wrap justify-between gap-2 rounded border bg-card px-2 py-1.5"
              >
                <span className="font-medium">{row.supplierName}</span>
                <span className="text-red-700 dark:text-red-400">
                  {[
                    row.hasRawStock ? "raw stock" : null,
                    row.hasAdjustment ? "adjustment" : null,
                    row.hasOwnedSource ? "owned source" : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(preview.unclassifiedAdjustmentRows?.length ?? 0) > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            Historical additions requiring explicit valuation classification
          </div>
          <p className="text-xs text-muted-foreground">
            Do not classify from the description alone. Choose Quantity only when the addition used the supplier’s
            existing rate; Valued transfer when its recorded cost is a real USD value; Opening balance only when it
            established starting stock.
          </p>
          <div className="overflow-x-auto rounded-md border bg-card">
            <Table mobileLayout="cards">
              <TableHeader>
                <TableRow>
                  <TableHead>Supplier / reference</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Kg</TableHead>
                  <TableHead className="text-right">Recorded cost/kg</TableHead>
                  <TableHead className="text-right">Classify</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.unclassifiedAdjustmentRows?.map((row) => (
                  <TableRow key={row.adjustmentId}>
                    <TableCell>
                      <div className="font-medium">{row.supplierName}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.reference || row.notes || `Adjustment #${row.adjustmentId}`}
                      </div>
                    </TableCell>
                    <TableCell>{row.date}</TableCell>
                    <TableCell className="text-right tabular-nums">{number(row.kg)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(row.costPerKg)} {row.currencyCode}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {(["QUANTITY_ONLY", "VALUED_TRANSFER", "OPENING_BALANCE"] as const).map((basis) => (
                          <Button
                            key={basis}
                            size="sm"
                            variant="outline"
                            disabled={classifyMutation.isPending}
                            onClick={() => {
                              const readable = basis.replaceAll("_", " ").toLowerCase();
                              if (!window.confirm(`Classify adjustment #${row.adjustmentId} as ${readable}?`)) return;
                              classifyMutation.mutate({ adjustmentId: row.adjustmentId, valuationBasis: basis });
                            }}
                          >
                            {basis === "QUANTITY_ONLY"
                              ? "Quantity only"
                              : basis === "VALUED_TRANSFER"
                                ? "Valued transfer"
                                : "Opening balance"}
                          </Button>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {(preview.blockedBatches?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <div className="mb-2 text-sm font-semibold text-red-700 dark:text-red-400">Blocked batches</div>
          <div className="space-y-1 text-xs">
            {preview.blockedBatches?.map((batch) => (
              <div
                key={batch.batchId}
                className="flex flex-wrap justify-between gap-2 rounded border bg-card px-2 py-1.5"
              >
                <span className="font-mono">{batch.batchCode}</span>
                <span className="text-red-700 dark:text-red-400">{batch.reasons.join(", ")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <Table mobileLayout="cards">
          <TableHeader>
            <TableRow>
              <TableHead>Supplier</TableHead>
              <TableHead className="text-right">Remaining kg</TableHead>
              <TableHead className="text-right">Current rate</TableHead>
              <TableHead className="text-right">Replay rate</TableHead>
              <TableHead className="text-right">Current value</TableHead>
              <TableHead className="text-right">Projected value</TableHead>
              <TableHead className="text-right">Change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {impact.supplierImpacts.map((row) => (
              <TableRow key={row.supplierId}>
                <TableCell className="font-medium">{row.supplierName}</TableCell>
                <TableCell className="text-right tabular-nums">{number(row.replayRemainingKg)}</TableCell>
                <TableCell className="text-right font-mono">${row.currentStoredRate.toFixed(8)}</TableCell>
                <TableCell className="text-right font-mono">${row.endingExpectedRate.toFixed(8)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.currentValue)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.projectedValue)}</TableCell>
                <TableCell
                  className={`text-right font-semibold tabular-nums ${row.valueDifference < 0 ? "text-red-600" : "text-emerald-600"}`}
                >
                  {money(row.valueDifference)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="text-xs text-muted-foreground">
        Completed batches affected: <strong>{impact.completedBatchesAffected}</strong> · Available bales affected:{" "}
        <strong>{impact.availableBalesAffected}</strong> · Finalized/sold bales excluded:{" "}
        <strong>{impact.finalizedBalesExcluded}</strong> · Other ledger effect:{" "}
        <strong>{money(impact.otherLedgerEffect)}</strong>
      </div>
    </div>
  );
}
