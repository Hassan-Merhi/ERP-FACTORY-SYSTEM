import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  Edit3,
  Lock,
  Loader2,
  RefreshCw,
  Save,
  Shuffle,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readActiveCompanyScope } from "@/lib/progressivePagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ContainerPlannerReconciliation } from "./ContainerPlannerReconciliation";

interface PlanSummary {
  id: number;
  name: string;
  status: string;
  capacityBales: number;
  includeGarbageWipers: boolean;
  sourcePlannableTotal: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  containerCount: number;
  lockedCount: number;
  totalPlanned: number;
}

interface PlanLine {
  id: number;
  articleCode: string;
  productName: string;
  plannedQty: number;
}

interface PlanContainer {
  id: number;
  position: number;
  name: string;
  capacityBales: number;
  isLocked: boolean;
  lockedAt: string | null;
  lockedBy: string | null;
  lockedByName: string | null;
  totalBales: number;
  lines: PlanLine[];
}

interface PlanDetail {
  id: number;
  name: string;
  status: string;
  capacityBales: number;
  includeGarbageWipers: boolean;
  sourceStockTotal: number;
  sourceCommittedTotal: number;
  sourceLoadingTotal: number;
  sourcePlannableTotal: number;
  revision: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  totalPlanned: number;
  lockedCount: number;
  containers: PlanContainer[];
}

interface MoveSource {
  containerId: number;
  containerName: string;
  articleCode: string;
  productName: string;
  maxQty: number;
}

interface Props {
  capacityBales: number;
  includeGarbageWipers: boolean;
  previewTotal: number;
}

function formatQty(value: number): string {
  return Math.round(Number(value || 0)).toLocaleString();
}

function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `container-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || "Request failed");
  return body as T;
}

export function ContainerPlannerSavedPlans({
  capacityBales,
  includeGarbageWipers,
  previewTotal,
}: Props) {
  const { toast } = useToast();
  const companyScope = readActiveCompanyScope();

  const [planName, setPlanName] = useState("");
  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [moveSource, setMoveSource] = useState<MoveSource | null>(null);
  const [moveQty, setMoveQty] = useState("1");
  const [moveDestinationId, setMoveDestinationId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Keep the same request identity after an ambiguous network failure. If the
  // first save committed but its response was lost, retrying with this key lets
  // the server return that same draft instead of creating a duplicate.
  const saveRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    setSelectedPlanId(null);
    setMoveSource(null);
    setConfirmDelete(false);
    saveRequestIdRef.current = null;
  }, [companyScope]);

  useEffect(() => {
    saveRequestIdRef.current = null;
  }, [planName, capacityBales, includeGarbageWipers]);

  const plansQuery = useQuery<{ plans: PlanSummary[] }>({
    queryKey: ["/api/factory/v5/container-plans", companyScope],
    queryFn: () => getJson("/api/factory/v5/container-plans"),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const firstPlanId = plansQuery.data?.plans?.[0]?.id ?? null;

  useEffect(() => {
    if (selectedPlanId == null && firstPlanId != null) {
      setSelectedPlanId(Number(firstPlanId));
    }
  }, [firstPlanId, selectedPlanId]);

  const detailQuery = useQuery<{ plan: PlanDetail }>({
    queryKey: ["/api/factory/v5/container-plans/detail", companyScope, selectedPlanId],
    queryFn: () => getJson(`/api/factory/v5/container-plans/${selectedPlanId}`),
    enabled: selectedPlanId != null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const detail = detailQuery.data?.plan ?? null;

  useEffect(() => {
    if (detail) setRenameValue(detail.name);
  }, [detail]);

  function invalidatePlanner(planId?: number | null) {
    queryClient.invalidateQueries({ queryKey: ["/api/factory/v5/container-plans", companyScope] });
    if (planId) {
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/v5/container-plans/detail", companyScope, planId],
      });
      queryClient.invalidateQueries({
        queryKey: ["/api/factory/v5/container-plans/reconciliation", companyScope, planId],
      });
    }
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const clientRequestId = saveRequestIdRef.current ?? requestId();
      saveRequestIdRef.current = clientRequestId;
      const response = await apiRequest("POST", "/api/factory/v5/container-plans", {
        name: planName.trim() || undefined,
        capacityBales,
        includeGarbageWipers,
        clientRequestId,
      });
      return (await response.json()) as { plan: PlanDetail; duplicate?: boolean };
    },
    onSuccess: (data) => {
      saveRequestIdRef.current = null;
      setSelectedPlanId(data.plan.id);
      setPlanName("");
      invalidatePlanner(data.plan.id);
      toast({
        title: data.duplicate ? "Plan already saved" : "Container plan saved",
        description: `${data.plan.containers.length} containers · ${formatQty(data.plan.totalPlanned)} bales`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Could not save plan", description: error.message, variant: "destructive" });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async ({ planId, name }: { planId: number; name: string }) => {
      const response = await apiRequest("PATCH", `/api/factory/v5/container-plans/${planId}`, { name });
      return (await response.json()) as { plan: PlanDetail };
    },
    onSuccess: (data) => {
      invalidatePlanner(data.plan.id);
      toast({ title: "Plan renamed" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not rename plan", description: error.message, variant: "destructive" });
    },
  });

  const lockMutation = useMutation({
    mutationFn: async ({
      planId,
      containerId,
      isLocked,
    }: {
      planId: number;
      containerId: number;
      isLocked: boolean;
    }) => {
      const response = await apiRequest(
        "PATCH",
        `/api/factory/v5/container-plans/${planId}/containers/${containerId}/lock`,
        { isLocked }
      );
      return (await response.json()) as { plan: PlanDetail };
    },
    onSuccess: (data) => {
      setMoveSource(null);
      invalidatePlanner(data.plan.id);
      toast({ title: "Container lock updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not update lock", description: error.message, variant: "destructive" });
    },
  });

  const moveMutation = useMutation({
    mutationFn: async ({
      planId,
      source,
      destinationId,
      quantity,
    }: {
      planId: number;
      source: MoveSource;
      destinationId: number;
      quantity: number;
    }) => {
      const response = await apiRequest("POST", `/api/factory/v5/container-plans/${planId}/move`, {
        fromContainerId: source.containerId,
        toContainerId: destinationId,
        articleCode: source.articleCode,
        quantity,
      });
      return (await response.json()) as { plan: PlanDetail };
    },
    onSuccess: (data) => {
      setMoveSource(null);
      setMoveQty("1");
      setMoveDestinationId("");
      invalidatePlanner(data.plan.id);
      toast({ title: "Bales moved" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not move bales", description: error.message, variant: "destructive" });
    },
  });

  const rebalanceMutation = useMutation({
    mutationFn: async (planId: number) => {
      const response = await apiRequest("POST", `/api/factory/v5/container-plans/${planId}/rebalance`, {});
      return (await response.json()) as { plan: PlanDetail };
    },
    onSuccess: (data) => {
      setMoveSource(null);
      invalidatePlanner(data.plan.id);
      toast({
        title: "Unlocked containers rebalanced",
        description: "Locked containers were left unchanged.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Could not rebalance plan", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (planId: number) => {
      const response = await apiRequest("DELETE", `/api/factory/v5/container-plans/${planId}`);
      return (await response.json()) as { success: boolean };
    },
    onSuccess: () => {
      setSelectedPlanId(null);
      setMoveSource(null);
      setConfirmDelete(false);
      invalidatePlanner();
      toast({ title: "Container plan deleted" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not delete plan", description: error.message, variant: "destructive" });
    },
  });

  const productRows = useMemo(() => {
    if (!detail) return [];
    const map = new Map<string, { articleCode: string; productName: string }>();
    for (const container of detail.containers) {
      for (const line of container.lines) {
        if (!map.has(line.articleCode)) {
          map.set(line.articleCode, { articleCode: line.articleCode, productName: line.productName });
        }
      }
    }
    return Array.from(map.values()).sort(
      (a, b) => a.productName.localeCompare(b.productName) || a.articleCode.localeCompare(b.articleCode)
    );
  }, [detail]);

  const lineLookup = useMemo(() => {
    const map = new Map<string, PlanLine>();
    if (!detail) return map;
    for (const container of detail.containers) {
      for (const line of container.lines) {
        map.set(`${container.id}__${line.articleCode}`, line);
      }
    }
    return map;
  }, [detail]);

  const unlockedDestinations = useMemo(() => {
    if (!detail || !moveSource) return [];
    return detail.containers.filter(
      (container) =>
        !container.isLocked &&
        container.id !== moveSource.containerId &&
        container.totalBales < container.capacityBales
    );
  }, [detail, moveSource]);

  useEffect(() => {
    if (!moveSource) {
      setMoveDestinationId("");
      return;
    }
    if (unlockedDestinations.length > 0) {
      setMoveDestinationId(String(unlockedDestinations[0].id));
    } else {
      setMoveDestinationId("");
    }
  }, [moveSource, unlockedDestinations]);

  const isBusy =
    saveMutation.isPending ||
    renameMutation.isPending ||
    lockMutation.isPending ||
    moveMutation.isPending ||
    rebalanceMutation.isPending ||
    deleteMutation.isPending;

  return (
    <div className="space-y-4" data-testid="container-planner-phase-2">
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
              {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save Plan
            </Button>
          </div>
        </div>
      </div>

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

      {selectedPlanId != null && (
        <div className="rounded-lg border bg-background p-3">
          {detailQuery.isLoading ? (
            <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading plan…
            </div>
          ) : detailQuery.isError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {(detailQuery.error as Error)?.message || "Could not load plan."}
            </div>
          ) : detail ? (
            <div className="space-y-4">
              <div className="flex flex-col justify-between gap-3 xl:flex-row xl:items-start">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-base font-semibold">{detail.name}</h3>
                    <Badge variant="secondary">{detail.status}</Badge>
                    <Badge variant="outline">rev {detail.revision}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {detail.containers.length} containers · {formatQty(detail.totalPlanned)} planned bales ·{" "}
                    {detail.lockedCount} locked
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isBusy || detail.containers.length === 0}
                    onClick={() => rebalanceMutation.mutate(detail.id)}
                    data-testid="button-rebalance-container-plan"
                  >
                    {rebalanceMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Shuffle className="mr-2 h-4 w-4" />
                    )}
                    Rebalance Unlocked
                  </Button>
                  {!confirmDelete ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => setConfirmDelete(true)}
                      data-testid="button-delete-container-plan"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteMutation.mutate(detail.id)}
                        data-testid="button-confirm-delete-container-plan"
                      >
                        <Check className="mr-2 h-4 w-4" />
                        Confirm Delete
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                        <X className="mr-2 h-4 w-4" />
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  className="h-9 max-w-md"
                  maxLength={120}
                  data-testid="input-rename-container-plan"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={renameMutation.isPending || !renameValue.trim() || renameValue.trim() === detail.name}
                  onClick={() => renameMutation.mutate({ planId: detail.id, name: renameValue.trim() })}
                  data-testid="button-rename-container-plan"
                >
                  <Edit3 className="mr-2 h-4 w-4" />
                  Save Name
                </Button>
              </div>

              <ContainerPlannerReconciliation
                planId={detail.id}
                onPlanChanged={() => invalidatePlanner(detail.id)}
              />

              <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
                {detail.containers.map((container) => (
                  <Card key={container.id} className={container.isLocked ? "border-amber-500/40" : undefined}>
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold">{container.name}</div>
                          <div className="mt-1 text-lg font-semibold tabular-nums">
                            {formatQty(container.totalBales)}
                            <span className="ml-1 text-xs font-normal text-muted-foreground">
                              / {formatQty(container.capacityBales)}
                            </span>
                          </div>
                        </div>
                        <Button
                          size="icon"
                          variant={container.isLocked ? "secondary" : "ghost"}
                          className="h-8 w-8 shrink-0"
                          disabled={lockMutation.isPending}
                          onClick={() =>
                            lockMutation.mutate({
                              planId: detail.id,
                              containerId: container.id,
                              isLocked: !container.isLocked,
                            })
                          }
                          title={container.isLocked ? "Unlock container" : "Lock container"}
                          data-testid={`button-container-lock-${container.id}`}
                        >
                          {container.isLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                        </Button>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full bg-foreground/50"
                          style={{
                            width: `${Math.min(
                              100,
                              container.capacityBales > 0 ? (container.totalBales / container.capacityBales) * 100 : 0
                            )}%`,
                          }}
                        />
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {container.isLocked ? "Locked · rebalance protected" : "Unlocked"}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {moveSource && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3" data-testid="container-plan-move-panel">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground">Move product</p>
                      <p className="truncate text-sm font-semibold">
                        {moveSource.productName} · {moveSource.containerName}
                      </p>
                      <p className="text-xs text-muted-foreground">Up to {formatQty(moveSource.maxQty)} bales available.</p>
                    </div>
                    <div className="w-full lg:w-28">
                      <label className="mb-1 block text-xs text-muted-foreground">Quantity</label>
                      <Input
                        value={moveQty}
                        onChange={(event) => setMoveQty(event.target.value)}
                        inputMode="numeric"
                        className="h-9"
                        data-testid="input-container-plan-move-qty"
                      />
                    </div>
                    <div className="w-full lg:w-56">
                      <label className="mb-1 block text-xs text-muted-foreground">Destination</label>
                      <select
                        value={moveDestinationId}
                        onChange={(event) => setMoveDestinationId(event.target.value)}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        data-testid="select-container-plan-move-destination"
                      >
                        {unlockedDestinations.length === 0 ? (
                          <option value="">No unlocked destination has space</option>
                        ) : (
                          unlockedDestinations.map((container) => (
                            <option key={container.id} value={container.id}>
                              {container.name} · {formatQty(container.capacityBales - container.totalBales)} free
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <Button
                      size="sm"
                      disabled={
                        moveMutation.isPending ||
                        !moveDestinationId ||
                        !Number.isSafeInteger(Number(moveQty)) ||
                        Number(moveQty) < 1 ||
                        Number(moveQty) > moveSource.maxQty
                      }
                      onClick={() =>
                        moveMutation.mutate({
                          planId: detail.id,
                          source: moveSource,
                          destinationId: Number(moveDestinationId),
                          quantity: Number(moveQty),
                        })
                      }
                      data-testid="button-container-plan-move-submit"
                    >
                      {moveMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <ArrowRight className="mr-2 h-4 w-4" />
                      )}
                      Move
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setMoveSource(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              <div className="overflow-auto rounded-lg border">
                <table className="w-full min-w-max border-collapse text-xs" data-testid="saved-container-plan-matrix">
                  <thead>
                    <tr className="bg-muted">
                      <th className="sticky left-0 z-20 min-w-[220px] border-b border-r bg-muted px-3 py-2 text-left">
                        Product
                      </th>
                      {detail.containers.map((container) => (
                        <th key={container.id} className="min-w-[100px] border-b border-r px-2 py-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {container.isLocked && <Lock className="h-3 w-3 text-amber-600" />}
                            <span>{container.name}</span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {productRows.map((product, rowIndex) => (
                      <tr key={product.articleCode} className={rowIndex % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                        <td className="sticky left-0 z-10 border-b border-r bg-inherit px-3 py-2">
                          <div className="font-medium">{product.productName}</div>
                          <div className="font-mono text-[10px] text-muted-foreground">{product.articleCode}</div>
                        </td>
                        {detail.containers.map((container) => {
                          const line = lineLookup.get(`${container.id}__${product.articleCode}`);
                          const qty = line?.plannedQty ?? 0;
                          return (
                            <td key={container.id} className="border-b border-r px-2 py-1 text-right font-mono tabular-nums">
                              {qty > 0 && !container.isLocked ? (
                                <button
                                  type="button"
                                  className="rounded px-2 py-1 hover:bg-primary/10 hover:text-primary"
                                  onClick={() => {
                                    setMoveSource({
                                      containerId: container.id,
                                      containerName: container.name,
                                      articleCode: product.articleCode,
                                      productName: product.productName,
                                      maxQty: qty,
                                    });
                                    setMoveQty(String(Math.min(qty, 1)));
                                  }}
                                  title="Move bales to another unlocked container"
                                  data-testid={`button-move-${container.id}-${product.articleCode}`}
                                >
                                  {formatQty(qty)}
                                </button>
                              ) : qty > 0 ? (
                                <span className={container.isLocked ? "text-amber-700 dark:text-amber-400" : undefined}>
                                  {formatQty(qty)}
                                </span>
                              ) : (
                                <span className="text-muted-foreground/40">—</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted font-semibold">
                      <td className="sticky left-0 z-20 border-r bg-muted px-3 py-2">TOTAL</td>
                      {detail.containers.map((container) => (
                        <td key={container.id} className="border-r px-2 py-2 text-right font-mono tabular-nums">
                          {formatQty(container.totalBales)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>

              <p className="text-[11px] text-muted-foreground">
                Clicking a quantity in an unlocked container opens the move control. Moving bales preserves the plan's
                product totals. Rebalance rewrites unlocked containers only; locked containers are never changed.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
