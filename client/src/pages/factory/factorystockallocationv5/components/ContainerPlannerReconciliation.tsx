import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Shuffle } from "lucide-react";
import type { ContainerPlannerReconciliation as Reconciliation } from "@shared/containerPlanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readActiveCompanyScope } from "@/lib/progressivePagination";

interface ReconciliationResponse {
  planId: number;
  revision: number;
  checkedAt: string;
  reconciliation: Reconciliation;
}

interface ReconcileResponse extends ReconciliationResponse {
  success: boolean;
  addedContainers: number;
  removedContainers: number;
}

interface Props {
  planId: number;
  onPlanChanged: () => void;
}

function formatQty(value: number): string {
  return Math.round(Number(value || 0)).toLocaleString();
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || "Request failed");
  return body as T;
}

export function ContainerPlannerReconciliation({ planId, onPlanChanged }: Props) {
  const { toast } = useToast();
  const companyScope = readActiveCompanyScope();
  const queryKey = ["/api/factory/v5/container-plans/reconciliation", companyScope, planId] as const;

  const reconciliationQuery = useQuery<ReconciliationResponse>({
    queryKey,
    queryFn: () => getJson(`/api/factory/v5/container-plans/${planId}/reconciliation`),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });

  const reconcileMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/factory/v5/container-plans/${planId}/reconcile`, {});
      return (await response.json()) as ReconcileResponse;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      onPlanChanged();
      toast({
        title: "Container plan reconciled",
        description: "Plan now matches current stock.",
      });
    },
    onError: (error: Error) => {
      reconciliationQuery.refetch();
      toast({ title: "Could not reconcile plan", description: error.message, variant: "destructive" });
    },
  });

  const reconciliation = reconciliationQuery.data?.reconciliation ?? null;
  const driftProducts = useMemo(
    () =>
      reconciliation?.products.filter(
        (product) => product.unplannedQty > 0 || product.overplannedQty > 0 || product.lockedConflictQty > 0
      ) ?? [],
    [reconciliation]
  );

  if (reconciliationQuery.isLoading) {
    return (
      <div className="rounded-lg border bg-muted/10 p-4" data-testid="container-plan-reconciliation-loading">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking plan against current stock…
        </div>
      </div>
    );
  }

  if (reconciliationQuery.isError || !reconciliation) {
    return (
      <div
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"
        data-testid="container-plan-reconciliation-error"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-destructive">Could not check current stock against this plan.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {(reconciliationQuery.error as Error)?.message || "Please refresh and try again."}
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => reconciliationQuery.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const inSync = reconciliation.status === "IN_SYNC";
  const lockedConflict = reconciliation.status === "LOCKED_CONFLICT";

  return (
    <div className="rounded-lg border bg-background p-3" data-testid="container-plan-reconciliation">
      <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold">Live stock reconciliation</h4>
            <Badge variant="outline">Phase 3</Badge>
            {inSync ? (
              <Badge variant="secondary">In sync</Badge>
            ) : lockedConflict ? (
              <Badge variant="destructive">Locked conflict</Badge>
            ) : (
              <Badge variant="secondary">Stock changed</Badge>
            )}
          </div>
          <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
            Compares this saved plan with current uncommitted V5 stock. Nothing changes until Reconcile to Current Stock
            is pressed.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={reconciliationQuery.isFetching || reconcileMutation.isPending}
            onClick={() => reconciliationQuery.refetch()}
            data-testid="button-refresh-container-plan-reconciliation"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${reconciliationQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh Check
          </Button>
          <Button
            size="sm"
            disabled={inSync || lockedConflict || reconcileMutation.isPending}
            onClick={() => reconcileMutation.mutate()}
            data-testid="button-reconcile-container-plan"
          >
            {reconcileMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Shuffle className="mr-2 h-4 w-4" />
            )}
            Reconcile to Current Stock
          </Button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Current available</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatQty(reconciliation.currentPlannableTotal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Plan total</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatQty(reconciliation.plannedTotal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">New / unplanned</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatQty(reconciliation.unplannedTotal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Over-planned</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatQty(reconciliation.overplannedTotal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Locked conflicts</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatQty(reconciliation.lockedConflictTotal)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Customer committed now</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">{formatQty(reconciliation.currentCommittedTotal)}</p>
          </CardContent>
        </Card>
      </div>

      {inSync ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-green-600/20 bg-green-600/5 px-3 py-2 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-700 dark:text-green-400" />
          <div>
            <span className="font-medium">This plan matches current free stock.</span>{" "}
            <span className="text-muted-foreground">No reconciliation is needed.</span>
          </div>
        </div>
      ) : lockedConflict ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <span className="font-medium text-destructive">
              {formatQty(reconciliation.lockedConflictTotal)} locked bales conflict with current stock.
            </span>{" "}
            <span className="text-muted-foreground">
              Unlock the affected container or containers first. Phase 3 will never silently reduce a locked container.
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <span className="font-medium">Current stock has changed since this plan was saved.</span>{" "}
            <span className="text-muted-foreground">
              Reconcile will preserve locked containers, resize the unlocked container count when needed, and rebalance
              only the unlocked quantities.
            </span>
          </div>
        </div>
      )}

      {driftProducts.length > 0 && (
        <div className="mt-3 overflow-auto rounded-md border">
          <table
            className="w-full min-w-[760px] border-collapse text-xs"
            data-testid="container-plan-reconciliation-table"
          >
            <thead>
              <tr className="bg-muted">
                <th className="border-b border-r px-3 py-2 text-left">Product</th>
                <th className="border-b border-r px-3 py-2 text-right">Current</th>
                <th className="border-b border-r px-3 py-2 text-right">Planned</th>
                <th className="border-b border-r px-3 py-2 text-right">Change</th>
                <th className="border-b border-r px-3 py-2 text-right">Locked</th>
                <th className="border-b px-3 py-2 text-right">Locked conflict</th>
              </tr>
            </thead>
            <tbody>
              {driftProducts.map((product, index) => (
                <tr key={product.articleCode} className={index % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                  <td className="border-b border-r px-3 py-2">
                    <div className="font-medium">{product.productName}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{product.articleCode}</div>
                  </td>
                  <td className="border-b border-r px-3 py-2 text-right font-mono tabular-nums">
                    {formatQty(product.currentPlannableQty)}
                  </td>
                  <td className="border-b border-r px-3 py-2 text-right font-mono tabular-nums">
                    {formatQty(product.plannedQty)}
                  </td>
                  <td className="border-b border-r px-3 py-2 text-right font-mono tabular-nums">
                    {product.deltaQty > 0 ? "+" : ""}
                    {formatQty(product.deltaQty)}
                  </td>
                  <td className="border-b border-r px-3 py-2 text-right font-mono tabular-nums">
                    {formatQty(product.lockedQty)}
                  </td>
                  <td className="border-b px-3 py-2 text-right font-mono tabular-nums">
                    {formatQty(product.lockedConflictQty)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">
        Checked {new Date(reconciliationQuery.data!.checkedAt).toLocaleTimeString()}. Locked containers are preserved
        exactly; reconciliation never reserves physical bale IDs or changes customer loading.
      </p>
    </div>
  );
}
