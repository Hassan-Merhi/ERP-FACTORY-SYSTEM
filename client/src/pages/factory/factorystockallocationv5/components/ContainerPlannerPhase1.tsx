import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Calculator, Container, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchAllV5AllocationData } from "@/lib/v5AllocationPaginationClient";
import { readActiveCompanyScope } from "@/lib/progressivePagination";
import {
  buildContainerPlannerPreview,
  DEFAULT_CONTAINER_CAPACITY,
  MAX_CONTAINER_CAPACITY,
} from "../containerPlannerEngine";

function fmt(value: number): string {
  return Math.round(value).toLocaleString();
}

export function ContainerPlannerPhase1() {
  const [capacityInput, setCapacityInput] = useState(String(DEFAULT_CONTAINER_CAPACITY));
  const [capacity, setCapacity] = useState(DEFAULT_CONTAINER_CAPACITY);
  const [includeGarbageWipers, setIncludeGarbageWipers] = useState(false);
  const [capacityError, setCapacityError] = useState("");

  const companyScope = readActiveCompanyScope();
  const query = useQuery({
    queryKey: ["/api/factory/v5/container-planner-preview-source", companyScope],
    queryFn: () => fetchAllV5AllocationData(new URLSearchParams()),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const preview = useMemo(
    () =>
      buildContainerPlannerPreview(query.data?.rows ?? [], capacity, {
        includeGarbageWipers,
      }),
    [query.data?.rows, capacity, includeGarbageWipers]
  );

  function generatePreview() {
    const parsed = Number(capacityInput);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONTAINER_CAPACITY) {
      setCapacityError(`Enter a whole-number capacity from 1 to ${MAX_CONTAINER_CAPACITY.toLocaleString()} bales.`);
      return;
    }
    setCapacityError("");
    setCapacity(parsed);
  }

  if (query.isLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center border-b bg-muted/10" data-testid="container-planner-loading">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading the complete stock picture…
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="border-b p-4" data-testid="container-planner-error">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <div>
              <p className="font-medium">Container Planner could not load the complete stock list.</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {(query.error as Error)?.message || "Please refresh and try again."}
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <section className="border-b bg-muted/10 p-3 sm:p-4" data-testid="container-planner-phase-1">
      <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4">
        <div className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">Container Planner</h2>
              <Badge variant="secondary">Phase 1 · Read-only</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Divides uncommitted V5 stock into balanced container previews. It does not reserve bales, move stock,
              create customer orders, or change loading status.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div>
              <label htmlFor="container-planner-capacity" className="mb-1 block text-xs font-medium text-muted-foreground">
                Target capacity (bales)
              </label>
              <Input
                id="container-planner-capacity"
                value={capacityInput}
                onChange={(event) => setCapacityInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") generatePreview();
                }}
                inputMode="numeric"
                className="h-9 w-full sm:w-40"
                data-testid="input-container-planner-capacity"
              />
            </div>
            <Button size="sm" onClick={generatePreview} data-testid="button-container-planner-generate">
              <Calculator className="mr-2 h-4 w-4" />
              Generate Preview
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              data-testid="button-container-planner-refresh"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`} />
              Refresh Stock
            </Button>
          </div>
        </div>

        {capacityError && <p className="text-sm font-medium text-destructive">{capacityError}</p>}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={includeGarbageWipers ? "secondary" : "outline"}
            onClick={() => setIncludeGarbageWipers((value) => !value)}
            data-testid="button-container-planner-garbage-wipers"
          >
            {includeGarbageWipers ? "Including Garbage/Wipers" : "Exclude Garbage/Wipers"}
          </Button>
          {!includeGarbageWipers && preview.excludedFromPlan > 0 && (
            <span className="text-xs text-muted-foreground">
              {fmt(preview.excludedFromPlan)} free bales excluded from this preview.
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 lg:grid-cols-6">
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Physical stock</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{fmt(preview.totalStockAvailable)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Customer committed</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{fmt(preview.customerCommitted)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Already loading</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{fmt(preview.alreadyLoading)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Available to plan</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-green-700 dark:text-green-400">
                {fmt(preview.totalPlannable)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Planned containers</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{preview.containerCount}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">Average / container</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{fmt(preview.averageBalesPerContainer)}</p>
            </CardContent>
          </Card>
        </div>

        {preview.shortageBales > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <span className="font-medium text-destructive">{fmt(preview.shortageBales)} bale shortage detected.</span>{" "}
              <span className="text-muted-foreground">
                Shortages are never placed into planned containers; only positive Available Balance is distributed.
              </span>
            </div>
          </div>
        )}

        {preview.containerCount === 0 ? (
          <Card>
            <CardContent className="p-8 text-center text-sm text-muted-foreground">
              There is no positive uncommitted stock to distribute right now.
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="rounded-lg border bg-background p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Container className="h-4 w-4" />
                  <span className="text-sm font-semibold">Balanced container totals</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Every planned bale is accounted for exactly once.
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 xl:grid-cols-8">
                {preview.containers.map((container) => (
                  <div key={container.index} className="rounded-md border bg-muted/20 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold">C{container.index + 1}</span>
                      <span className="text-[11px] text-muted-foreground">{container.fillPercent.toFixed(1)}%</span>
                    </div>
                    <div className="mt-1 text-lg font-semibold tabular-nums">
                      {fmt(container.totalBales)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">/ {preview.capacity}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="overflow-auto rounded-lg border bg-background">
              <table className="w-full min-w-max border-collapse text-xs" data-testid="container-planner-matrix">
                <thead>
                  <tr className="sticky top-0 z-10 bg-muted">
                    <th className="sticky left-0 z-20 min-w-[220px] border-b border-r bg-muted px-3 py-2 text-left font-medium">
                      Product
                    </th>
                    <th className="min-w-[90px] border-b border-r px-3 py-2 text-right font-medium">Free stock</th>
                    {preview.containers.map((container) => (
                      <th key={container.index} className="min-w-[78px] border-b border-r px-2 py-2 text-right font-medium">
                        C{container.index + 1}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.products.map((product, rowIndex) => (
                    <tr key={product.articleCode} className={rowIndex % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                      <td className="sticky left-0 z-[5] border-b border-r bg-inherit px-3 py-2">
                        <div className="font-medium">{product.productName}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{product.articleCode}</div>
                      </td>
                      <td className="border-b border-r px-3 py-2 text-right font-mono font-semibold tabular-nums">
                        {fmt(product.plannableQty)}
                      </td>
                      {product.allocations.map((quantity, containerIndex) => (
                        <td
                          key={containerIndex}
                          className="border-b border-r px-2 py-2 text-right font-mono tabular-nums text-muted-foreground"
                        >
                          {quantity || "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="sticky bottom-0 bg-muted font-semibold">
                    <td className="sticky left-0 z-20 border-r bg-muted px-3 py-2">TOTAL</td>
                    <td className="border-r px-3 py-2 text-right font-mono tabular-nums">{fmt(preview.totalPlannable)}</td>
                    {preview.containers.map((container) => (
                      <td key={container.index} className="border-r px-2 py-2 text-right font-mono tabular-nums">
                        {fmt(container.totalBales)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
