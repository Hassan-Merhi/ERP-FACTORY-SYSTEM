import { ArrowRight, Check, Lock, Pencil, Loader2, Shuffle, Trash2, Unlock, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ContainerPlannerReconciliation } from "./ContainerPlannerReconciliation";
import { ContainerPlannerBaleAssignment } from "./ContainerPlannerBaleAssignment";
import { ContainerPlannerCustomerAllocation } from "./ContainerPlannerCustomerAllocation";
import { ContainerPlannerShipments } from "./ContainerPlannerShipments";
import { ContainerPlannerOptimizer } from "./ContainerPlannerOptimizer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatQty, type Props } from "./ContainerPlannerSavedPlansTypes";
import { useContainerPlannerSavedPlansState } from "./useContainerPlannerSavedPlansState";
import {
  ContainerPlannerSavedPlansSection,
  ContainerPlannerSavedPlansSection2,
} from "./ContainerPlannerSavedPlansSection";

export function ContainerPlannerSavedPlans(props: Props) {
  const {
    confirmDelete,
    deleteMutation,
    detail,
    detailQuery,
    invalidatePlanner,
    isBusy,
    lineLookup,
    lockMutation,
    moveDestinationId,
    moveMutation,
    moveQty,
    moveSource,
    planName,
    plansQuery,
    previewTotal,
    productRows,
    rebalanceMutation,
    renameMutation,
    renameValue,
    saveMutation,
    selectedPlanId,
    setConfirmDelete,
    setMoveDestinationId,
    setMoveQty,
    setMoveSource,
    setPlanName,
    setRenameValue,
    setSelectedPlanId,
    unlockedDestinations,
  } = useContainerPlannerSavedPlansState(props);

  return (
    <div className="space-y-4" data-testid="container-planner-phase-2">
      <ContainerPlannerSavedPlansSection2
        planName={planName}
        previewTotal={previewTotal}
        saveMutation={saveMutation}
        setPlanName={setPlanName}
      />

      <ContainerPlannerSavedPlansSection
        plansQuery={plansQuery}
        selectedPlanId={selectedPlanId}
        setConfirmDelete={setConfirmDelete}
        setMoveSource={setMoveSource}
        setSelectedPlanId={setSelectedPlanId}
      />

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
                  <Pencil className="mr-2 h-4 w-4" />
                  Save Name
                </Button>
              </div>

              <ContainerPlannerReconciliation planId={detail.id} onPlanChanged={() => invalidatePlanner(detail.id)} />

              <ContainerPlannerBaleAssignment planId={detail.id} onPlanChanged={() => invalidatePlanner(detail.id)} />

              <ContainerPlannerCustomerAllocation
                planId={detail.id}
                onPlanChanged={() => invalidatePlanner(detail.id)}
              />

              <ContainerPlannerShipments planId={detail.id} onPlanChanged={() => invalidatePlanner(detail.id)} />

              <ContainerPlannerOptimizer
                planId={detail.id}
                capacityBales={detail.capacityBales}
                includeGarbageWipers={detail.includeGarbageWipers}
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
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {container.isLocked ? "Locked · rebalance protected" : "Unlocked"}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {moveSource && (
                <div
                  className="rounded-lg border border-primary/30 bg-primary/5 p-3"
                  data-testid="container-plan-move-panel"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-muted-foreground">Move product</p>
                      <p className="truncate text-sm font-semibold">
                        {moveSource.productName} · {moveSource.containerName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Up to {formatQty(moveSource.maxQty)} bales available.
                      </p>
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
                      <Select
                        value={moveDestinationId || "__none__"}
                        onValueChange={(v) => setMoveDestinationId(v === "__none__" ? "" : v)}
                      >
                        <SelectTrigger
                          className="h-9 w-full text-sm"
                          data-testid="select-container-plan-move-destination"
                          aria-label="Destination"
                        >
                          <SelectValue placeholder="Choose destination" />
                        </SelectTrigger>
                        <SelectContent>
                          {unlockedDestinations.length === 0 ? (
                            <SelectItem value="__none__">No unlocked destination has space</SelectItem>
                          ) : (
                            unlockedDestinations.map((container) => (
                              <SelectItem key={container.id} value={String(container.id)}>
                                {container.name} · {formatQty(container.capacityBales - container.totalBales)} free
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
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
                          <div className="font-mono text-[11px] text-muted-foreground">{product.articleCode}</div>
                        </td>
                        {detail.containers.map((container) => {
                          const line = lineLookup.get(`${container.id}__${product.articleCode}`);
                          const qty = line?.plannedQty ?? 0;
                          return (
                            <td
                              key={container.id}
                              className="border-b border-r px-2 py-1 text-right font-mono tabular-nums"
                            >
                              {qty > 0 && !container.isLocked ? (
                                <button
                                  type="button"
                                  className="rounded-sm px-2 py-1 hover:bg-primary/10 hover:text-primary"
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
