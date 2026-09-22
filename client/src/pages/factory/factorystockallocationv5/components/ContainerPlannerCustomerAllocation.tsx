import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, Loader2, RefreshCw, Trash2, Users } from "lucide-react";
import type { PlanAllocationSummary } from "@shared/containerCustomerAllocation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readActiveCompanyScope } from "@/lib/progressivePagination";

interface AllocationResponse {
  planId: number;
  planName: string;
  checkedAt: string;
  summary: PlanAllocationSummary;
}

interface PackingListResponse {
  customerName: string;
  totalQty: number;
  totalWeightKg: number;
  containers: Array<{
    containerId: number;
    containerName: string;
    totalQty: number;
    lines: Array<{ productName: string; allocatedQty: number; assignedQty: number; baleCodes: string[] }>;
  }>;
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

/**
 * Phase 5 workspace: reserve containers for customers and read back the loading
 * and packing list that falls out of those reservations.
 */
export function ContainerPlannerCustomerAllocation({ planId, onPlanChanged }: Props) {
  const { toast } = useToast();
  const companyScope = readActiveCompanyScope();
  const queryKey = ["/api/factory/v5/container-plans/allocations", companyScope, planId] as const;

  const [activeContainerId, setActiveContainerId] = useState<number | null>(null);
  const [packingListCustomerId, setPackingListCustomerId] = useState<number | null>(null);
  const [draftQty, setDraftQty] = useState<Record<string, string>>({});
  const [draftCustomerId, setDraftCustomerId] = useState<string>("");

  const allocationQuery = useQuery<AllocationResponse>({
    queryKey,
    queryFn: () => getJson(`/api/factory/v5/container-plans/${planId}/allocations`),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const packingListQuery = useQuery<PackingListResponse>({
    queryKey: ["/api/factory/v5/container-plans/packing-list", companyScope, planId, packingListCustomerId],
    queryFn: () => getJson(`/api/factory/v5/container-plans/${planId}/customers/${packingListCustomerId}/packing-list`),
    enabled: packingListCustomerId != null,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const summary = allocationQuery.data?.summary ?? null;
  const containers = summary?.containers ?? [];
  const selectedContainerId = activeContainerId ?? containers[0]?.containerId ?? null;
  const selectedContainer = containers.find((entry) => entry.containerId === selectedContainerId) ?? null;

  const customerOptions = useMemo(
    () => summary?.customers.map((customer) => ({ id: customer.customerId, name: customer.customerName })) ?? [],
    [summary]
  );

  const saveMutation = useMutation({
    mutationFn: async (payload: {
      containerId: number;
      customerId: number;
      lines: Array<{ articleCode: string; qty: number }>;
    }) => {
      const response = await apiRequest(
        "PUT",
        `/api/factory/v5/container-plans/${planId}/containers/${payload.containerId}/allocations`,
        { customerId: payload.customerId, lines: payload.lines }
      );
      return (await response.json()) as { summary: PlanAllocationSummary };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      onPlanChanged();
      setDraftQty({});
      toast({ title: "Container reserved for customer" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not reserve", description: error.message, variant: "destructive" }),
  });

  const releaseMutation = useMutation({
    mutationFn: async (payload: { containerId: number; customerId: number }) => {
      const response = await apiRequest(
        "DELETE",
        `/api/factory/v5/container-plans/${planId}/containers/${payload.containerId}/allocations/${payload.customerId}`,
        {}
      );
      return (await response.json()) as { released: number };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey });
      onPlanChanged();
      toast({ title: `${data.released} allocation lines released` });
    },
    onError: (error: Error) =>
      toast({ title: "Could not release", description: error.message, variant: "destructive" }),
  });

  if (allocationQuery.isLoading) {
    return (
      <div className="rounded-lg border bg-muted/10 p-4" data-testid="container-plan-allocations-loading">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading customer allocation…
        </div>
      </div>
    );
  }

  if (allocationQuery.isError || !summary) {
    return (
      <div
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"
        data-testid="container-plan-allocations-error"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-destructive">
            {(allocationQuery.error as Error)?.message || "Could not load customer allocation."}
          </p>
          <Button size="sm" variant="outline" onClick={() => allocationQuery.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const submitAllocation = () => {
    const customerId = Number(draftCustomerId);
    if (!selectedContainer || !Number.isSafeInteger(customerId) || customerId <= 0) return;
    const lines = selectedContainer.products
      .map((product) => ({ articleCode: product.articleCode, qty: Number(draftQty[product.articleCode] || 0) }))
      .filter((line) => Number.isSafeInteger(line.qty) && line.qty > 0);
    if (lines.length === 0) return;
    saveMutation.mutate({ containerId: selectedContainer.containerId, customerId, lines });
  };

  return (
    <div className="rounded-lg border bg-background p-3" data-testid="container-plan-allocations">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold">Customer allocation</p>
            <p className="text-xs text-muted-foreground">
              {formatQty(summary.allocatedTotal)} of {formatQty(summary.plannedTotal)} planned bales reserved ·{" "}
              {formatQty(summary.outstandingDemandTotal)} bales of open order demand
            </p>
          </div>
        </div>
        <Badge variant={summary.unallocatedTotal === 0 ? "default" : "secondary"}>
          {summary.unallocatedTotal === 0
            ? "Fully allocated"
            : `${formatQty(summary.unallocatedTotal)} bales unreserved`}
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
            data-testid={`card-container-allocation-${container.containerId}`}
          >
            <CardContent className="p-3">
              <div className="truncate text-xs font-semibold">{container.containerName}</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">
                {formatQty(container.allocatedQty)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">
                  / {formatQty(container.plannedQty)}
                </span>
              </div>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">
                {container.customers.length === 0
                  ? "Unreserved"
                  : container.customers.map((customer) => customer.customerName).join(", ")}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {selectedContainer && (
        <div className="mt-4 rounded-lg border p-3" data-testid="container-allocation-workspace">
          <p className="text-sm font-semibold">{selectedContainer.containerName}</p>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="text-[11px] text-muted-foreground" htmlFor="allocation-customer">
                Customer id
              </label>
              <Input
                id="allocation-customer"
                value={draftCustomerId}
                onChange={(event) => setDraftCustomerId(event.target.value.replace(/[^0-9]/g, ""))}
                placeholder={customerOptions[0] ? String(customerOptions[0].id) : "Customer id"}
                className="h-9 w-40"
                data-testid="input-allocation-customer"
              />
            </div>
            {selectedContainer.products.map((product) => (
              <div key={product.articleCode}>
                <label className="text-[11px] text-muted-foreground" htmlFor={`qty-${product.articleCode}`}>
                  {product.productName} (free {formatQty(product.unallocatedQty)})
                </label>
                <Input
                  id={`qty-${product.articleCode}`}
                  value={draftQty[product.articleCode] ?? ""}
                  onChange={(event) =>
                    setDraftQty((current) => ({
                      ...current,
                      [product.articleCode]: event.target.value.replace(/[^0-9]/g, ""),
                    }))
                  }
                  placeholder="0"
                  className="h-9 w-28"
                  data-testid={`input-allocation-qty-${product.articleCode}`}
                />
              </div>
            ))}
            <Button
              size="sm"
              disabled={saveMutation.isPending || !draftCustomerId}
              onClick={submitAllocation}
              data-testid="button-save-allocation"
            >
              Reserve
            </Button>
          </div>

          {selectedContainer.customers.length > 0 && (
            <div className="mt-3 space-y-1">
              {selectedContainer.customers.map((customer) => (
                <div
                  key={customer.customerId}
                  className="flex items-center justify-between rounded border px-2 py-1 text-xs"
                  data-testid={`row-container-customer-${customer.customerId}`}
                >
                  <span className="truncate">
                    {customer.customerName} · {formatQty(customer.allocatedQty)} bales
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => setPackingListCustomerId(customer.customerId)}
                      data-testid={`button-packing-list-${customer.customerId}`}
                    >
                      <FileText className="mr-1 h-3.5 w-3.5" />
                      Packing list
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      disabled={releaseMutation.isPending}
                      onClick={() =>
                        releaseMutation.mutate({
                          containerId: selectedContainer.containerId,
                          customerId: customer.customerId,
                        })
                      }
                      title="Release this customer's reservation"
                      data-testid={`button-release-allocation-${customer.customerId}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {summary.customers.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-xs" data-testid="table-customer-coverage">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 text-left font-medium">Customer</th>
                <th className="py-1 text-right font-medium">Order demand</th>
                <th className="py-1 text-right font-medium">Allocated</th>
                <th className="py-1 text-right font-medium">Outstanding</th>
                <th className="py-1 text-right font-medium">Containers</th>
              </tr>
            </thead>
            <tbody>
              {summary.customers.map((customer) => (
                <tr key={customer.customerId} className="border-t">
                  <td className="py-1">{customer.customerName}</td>
                  <td className="py-1 text-right tabular-nums">{formatQty(customer.demandQty)}</td>
                  <td className="py-1 text-right tabular-nums">{formatQty(customer.allocatedQty)}</td>
                  <td className="py-1 text-right tabular-nums">{formatQty(customer.outstandingQty)}</td>
                  <td className="py-1 text-right tabular-nums">{formatQty(customer.containerCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {packingListCustomerId != null && packingListQuery.data && (
        <div className="mt-4 rounded-lg border p-3" data-testid="customer-packing-list">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              Packing list · {packingListQuery.data.customerName} · {formatQty(packingListQuery.data.totalQty)} bales ·{" "}
              {formatQty(packingListQuery.data.totalWeightKg)} kg
            </p>
            <Button size="sm" variant="ghost" onClick={() => setPackingListCustomerId(null)}>
              Close
            </Button>
          </div>
          {packingListQuery.data.containers.map((container) => (
            <div key={container.containerId} className="mt-2">
              <p className="text-xs font-medium">
                {container.containerName} · {formatQty(container.totalQty)} bales
              </p>
              {container.lines.map((line) => (
                <p key={line.productName} className="mt-1 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{line.productName}</span> {formatQty(line.allocatedQty)}{" "}
                  allocated, {formatQty(line.assignedQty)} assigned
                  {line.baleCodes.length > 0 && <span className="font-mono"> · {line.baleCodes.join(", ")}</span>}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
