import { useQuery } from "@tanstack/react-query";
import { BarChart3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/formatNumber";

interface SmartTransferFeedbackSummary {
  feedbackVersion: 4;
  learningMode: "observe-only";
  counts: {
    previews: number;
    imports: number;
    approvals: number;
    finalizedPerformanceSamples: number;
  };
  adoption: {
    importRatePct: number;
    approvalRatePct: number;
  };
  editing: {
    quantityKeptPct: number;
    sourceKeptPct: number;
    editedImportPct: number;
  };
  performance: {
    sampleSize: number;
    forecastAccuracyPct: number;
    forecastBiasPct: number;
  };
  recommendations: string[];
}

export default function SmartTransferFeedbackSummaryCard() {
  const { data, isLoading, isFetching, refetch } = useQuery<SmartTransferFeedbackSummary>({
    queryKey: ["/api/stock-transfers/smart-feedback/summary", { days: 90 }],
    queryFn: async () => {
      const response = await fetch("/api/stock-transfers/smart-feedback/summary?days=90", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to load smart transfer accuracy");
      return response.json();
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="fixed bottom-20 right-6 z-30 w-72 rounded-lg border bg-background/95 p-3 text-xs shadow-lg backdrop-blur-sm">
        Loading smart-transfer accuracy…
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="fixed bottom-20 right-6 z-30 w-80 rounded-lg border bg-background/95 p-3 shadow-lg backdrop-blur-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          <div>
            <p className="text-sm font-semibold">Smart accuracy · 90 days</p>
            <p className="text-[11px] text-muted-foreground">Observe-only learning; rules never change automatically</p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => refetch()}
          disabled={isFetching}
          aria-label="Refresh smart transfer accuracy"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {data.counts.previews === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Generate and import smart previews to begin measuring acceptance and forecast accuracy.
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md border p-2">
              <p className="text-[10px] text-muted-foreground">Approved</p>
              <p className="text-base font-semibold">{data.counts.approvals}</p>
            </div>
            <div className="rounded-md border p-2">
              <p className="text-[10px] text-muted-foreground">Qty kept</p>
              <p className="text-base font-semibold">{formatNumber(data.editing.quantityKeptPct, 0)}%</p>
            </div>
            <div className="rounded-md border p-2">
              <p className="text-[10px] text-muted-foreground">Source kept</p>
              <p className="text-base font-semibold">{formatNumber(data.editing.sourceKeptPct, 0)}%</p>
            </div>
          </div>

          <div className="mt-2 rounded-md bg-muted/50 p-2 text-xs">
            {data.performance.sampleSize > 0 ? (
              <p>
                Forecast accuracy:{" "}
                <span className="font-semibold">{formatNumber(data.performance.forecastAccuracyPct, 0)}%</span>
                {" · "}
                {data.performance.sampleSize} finalized sample(s)
              </p>
            ) : (
              <p>Post-transfer accuracy appears after finalized transfers have at least seven days of sales history.</p>
            )}
          </div>

          {data.recommendations[0] && (
            <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{data.recommendations[0]}</p>
          )}
        </>
      )}
    </div>
  );
}
