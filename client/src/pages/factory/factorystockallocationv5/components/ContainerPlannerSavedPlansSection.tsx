// Extracted from ./ContainerPlannerSavedPlans.tsx to keep that module under the source-size cap.
import { Loader2, RefreshCw, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCount as formatQty } from "@/lib/formatNumber";
import { useContainerPlannerSavedPlansState } from "./useContainerPlannerSavedPlansState";

export function ContainerPlannerSavedPlansSection({
  plansQuery,
  selectedPlanId,
  setConfirmDelete,
  setMoveSource,
  setSelectedPlanId,
}: Pick<
  ReturnType<typeof useContainerPlannerSavedPlansState>,
  "plansQuery" | "selectedPlanId" | "setConfirmDelete" | "setMoveSource" | "setSelectedPlanId"
>) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Saved container plans</h3>
          <p className="text-xs text-muted-foreground">
            Edit quantities by moving bales between unlocked containers. Lock containers you do not want rebalanced.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => plansQuery.refetch()}
          disabled={plansQuery.isFetching}
          data-testid="button-refresh-container-plans"
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${plansQuery.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {plansQuery.isLoading ? (
        <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading saved plans…
        </div>
      ) : plansQuery.isError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {(plansQuery.error as Error)?.message || "Could not load saved plans."}
        </div>
      ) : (plansQuery.data?.plans?.length ?? 0) === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No saved container plans yet.
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {plansQuery.data!.plans.map((plan) => (
            <button
              key={plan.id}
              type="button"
              onClick={() => {
                setSelectedPlanId(Number(plan.id));
                setMoveSource(null);
                setConfirmDelete(false);
              }}
              className={
                selectedPlanId === Number(plan.id)
                  ? "min-w-[210px] rounded-lg border border-primary bg-primary/10 p-3 text-left"
                  : "min-w-[210px] rounded-lg border bg-muted/10 p-3 text-left transition-colors hover:bg-muted/30"
              }
              data-testid={`button-container-plan-${plan.id}`}
            >
              <div className="truncate text-sm font-semibold">{plan.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {plan.containerCount} containers · {formatQty(plan.totalPlanned)} bales
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>rev {plan.revision}</span>
                <span>
                  {plan.lockedCount}/{plan.containerCount} locked
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ContainerPlannerSavedPlansSection2({
  planName,
  previewTotal,
  saveMutation,
  setPlanName,
}: Pick<
  ReturnType<typeof useContainerPlannerSavedPlansState>,
  "planName" | "previewTotal" | "saveMutation" | "setPlanName"
>) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">Save this preview</h3>
            <Badge variant="outline">Phase 2</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Saving creates a planning draft only. Physical bales and customer loading remain untouched.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto">
          <Input
            value={planName}
            onChange={(event) => setPlanName(event.target.value)}
            placeholder="Optional plan name"
            className="h-9 sm:w-64"
            maxLength={120}
            data-testid="input-container-plan-name"
          />
          <Button
            size="sm"
            disabled={previewTotal <= 0 || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
            data-testid="button-save-container-plan"
          >
            {saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save Plan
          </Button>
        </div>
      </div>
    </div>
  );
}
