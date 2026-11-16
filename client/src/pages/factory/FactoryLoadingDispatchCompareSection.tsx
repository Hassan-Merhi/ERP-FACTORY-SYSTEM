// Extracted from ./FactoryLoadingDispatchCompare.tsx to keep that module under the source-size cap.
import { ArrowLeft, Layers3, Printer, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { dispatchBase, tripLabel } from "./FactoryLoadingDispatchCompareParts";
import { useFactoryLoadingDispatchCompareState } from "./useFactoryLoadingDispatchCompareState";

export function FactoryLoadingDispatchCompareSection({
  comparison,
  navigate,
  orderId,
  result,
  selectedId,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchCompareState>,
  "comparison" | "navigate" | "orderId" | "result" | "selectedId"
>) {
  return (
    <div className="rounded-2xl border border-blue-200 bg-gradient-to-r from-white via-blue-50 to-sky-100 p-4 dark:border-blue-500/25 dark:from-[hsl(var(--factory-hue)_53%_17%)] dark:via-[hsl(var(--factory-hue)_62%_17%)] dark:to-[hsl(var(--factory-hue)_78%_18%)] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-xl bg-blue-600 p-3 text-white">
            <Layers3 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold sm:text-xl">Dispatch Comparison</h1>
              <Badge variant="secondary">Loading #{orderId}</Badge>
              {result?.containerNumber && <Badge variant="outline">{result.containerNumber}</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {result?.dispatch ? tripLabel(result.dispatch.dispatchNumber) : "All truck trips"} · Physical verification
              versus loaded bale references
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(dispatchBase(orderId) + (selectedId ? "/" + selectedId : ""))}
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to {selectedId ? "trip" : "dispatches"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(dispatchBase(orderId) + (selectedId ? "/" + selectedId : "") + "/report")}
            data-testid="button-compare-dispatch-report"
          >
            <Printer className="mr-1.5 h-4 w-4" /> Print / Export
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void comparison.refetch()}
            disabled={comparison.isFetching}
          >
            <RefreshCw className={"mr-1.5 h-4 w-4" + (comparison.isFetching ? " animate-spin" : "")} /> Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}
