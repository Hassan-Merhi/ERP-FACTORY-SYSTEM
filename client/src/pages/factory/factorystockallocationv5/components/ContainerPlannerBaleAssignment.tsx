import { formatCount } from "@/lib/formatNumber";
import { Barcode, Boxes, Loader2, PackageCheck, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { useContainerPlannerBaleAssignmentState, type Props } from "./useContainerPlannerBaleAssignmentState";

/**
 * Phase 4 loading screen: turns planned quantities into named physical bales.
 *
 * Scanning is the primary input - the code box stays focused so a warehouse
 * operator can fire a barcode gun at it repeatedly - with auto-fill and manual
 * release as the fallbacks.
 */
export function ContainerPlannerBaleAssignment({ planId, onPlanChanged }: Props) {
  const {
    setActiveContainerId,
    scanValue,
    setScanValue,
    assignmentQuery,
    summary,
    containers,
    selectedContainerId,
    selectedContainer,
    selectedAssignments,
    assignMutation,
    releaseMutation,
  } = useContainerPlannerBaleAssignmentState({ planId, onPlanChanged });

  if (assignmentQuery.isLoading) {
    return (
      <div className="rounded-lg border bg-muted/10 p-4" data-testid="container-plan-bales-loading">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading physical bale assignment…
        </div>
      </div>
    );
  }

  if (assignmentQuery.isError || !summary) {
    return (
      <div
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"
        data-testid="container-plan-bales-error"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-destructive">
            {(assignmentQuery.error as Error)?.message || "Could not load bale assignment."}
          </p>
          <Button size="sm" variant="outline" onClick={() => assignmentQuery.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const submitScan = (value = scanValue) => {
    const code = value.trim();
    if (!code || selectedContainerId == null) return;
    setScanValue("");
    assignMutation.mutate({ containerId: selectedContainerId, baleCodes: [code] });
  };

  return (
    <div className="rounded-lg border bg-background p-3" data-testid="container-plan-bales">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold">Physical bales</p>
            <p className="text-xs text-muted-foreground">
              {formatCount(summary.assignedTotal)} of {formatCount(summary.plannedTotal)} planned bales assigned ·{" "}
              {formatCount(summary.assignedWeightKg)} kg
            </p>
          </div>
        </div>
        <Badge variant={summary.isPlanFullyAssigned ? "default" : "secondary"} data-testid="badge-assignment-status">
          {summary.isPlanFullyAssigned ? (
            <>
              <PackageCheck className="mr-1 h-3.5 w-3.5" />
              Ready to load
            </>
          ) : (
            `${formatCount(summary.remainingTotal)} bales still unassigned`
          )}
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        {containers.map((container) => (
          <Card
            key={container.containerId}
            className={`cursor-pointer transition ${
              container.containerId === selectedContainerId ? "border-foreground/40 bg-muted/40" : ""
            }`}
            onClick={() => setActiveContainerId(container.containerId)}
            data-testid={`card-container-bales-${container.containerId}`}
          >
            <CardContent className="p-3">
              <div className="truncate text-xs font-semibold">{container.containerName}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {formatCount(container.assignedQty)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  / {formatCount(container.plannedQty)}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full ${container.isFullyAssigned ? "bg-emerald-500" : "bg-foreground/50"}`}
                  style={{
                    width: `${Math.min(
                      100,
                      container.plannedQty > 0 ? (container.assignedQty / container.plannedQty) * 100 : 0
                    )}%`,
                  }}
                />
              </div>
              {container.isLocked && <p className="mt-2 text-[11px] text-amber-600">Locked</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {selectedContainer && (
        <div className="mt-4 rounded-lg border p-3" data-testid="container-bale-workspace">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">{selectedContainer.containerName}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  assignMutation.isPending || selectedContainer.isLocked || selectedContainer.remainingQty === 0
                }
                onClick={() => assignMutation.mutate({ containerId: selectedContainer.containerId, auto: true })}
                data-testid="button-auto-assign-bales"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Auto-fill {formatCount(selectedContainer.remainingQty)}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  releaseMutation.isPending || selectedContainer.isLocked || selectedContainer.assignedQty === 0
                }
                onClick={() => releaseMutation.mutate({ containerId: selectedContainer.containerId, all: true })}
                data-testid="button-release-all-bales"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Release all
              </Button>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Barcode className="h-4 w-4 text-muted-foreground" />
            <Input
              value={scanValue}
              onChange={(event) => setScanValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitScan();
                }
              }}
              placeholder="Scan or type a bale code, then press Enter"
              className="h-9 max-w-md"
              disabled={selectedContainer.isLocked || assignMutation.isPending}
              autoFocus
              data-testid="input-scan-bale"
            />
            <MobileBarcodeScanner
              onScan={(code) => submitScan(code)}
              disabled={selectedContainer.isLocked || assignMutation.isPending}
            />
            <Button
              size="sm"
              disabled={!scanValue.trim() || selectedContainer.isLocked || assignMutation.isPending}
              onClick={() => submitScan()}
              data-testid="button-scan-bale"
            >
              Assign
            </Button>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-medium">Product</th>
                  <th className="py-1 text-right font-medium">Planned</th>
                  <th className="py-1 text-right font-medium">Assigned</th>
                  <th className="py-1 text-right font-medium">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {selectedContainer.products.map((product) => (
                  <tr key={product.articleCode} className="border-t">
                    <td className="py-1">{product.productName}</td>
                    <td className="py-1 text-right tabular-nums">{formatCount(product.plannedQty)}</td>
                    <td className="py-1 text-right tabular-nums">{formatCount(product.assignedQty)}</td>
                    <td className="py-1 text-right tabular-nums">{formatCount(product.remainingQty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedAssignments.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1" data-testid="list-assigned-bales">
              {selectedAssignments.map((assignment) => (
                <Badge
                  key={assignment.assignmentId}
                  variant="outline"
                  className="cursor-pointer font-mono text-[11px]"
                  onClick={() =>
                    !selectedContainer.isLocked &&
                    releaseMutation.mutate({
                      containerId: selectedContainer.containerId,
                      baleIds: [assignment.baleId],
                    })
                  }
                  title="Click to release this bale"
                  data-testid={`badge-assigned-bale-${assignment.baleId}`}
                >
                  {assignment.baleCode}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {assignmentQuery.data && assignmentQuery.data.unassignedStock.length > 0 && (
        <div className="mt-3 text-xs text-muted-foreground" data-testid="text-unassigned-stock">
          Unassigned stock:{" "}
          {assignmentQuery.data.unassignedStock.map((row) => `${row.productName} ${formatCount(row.qty)}`).join(" · ")}
        </div>
      )}
    </div>
  );
}
