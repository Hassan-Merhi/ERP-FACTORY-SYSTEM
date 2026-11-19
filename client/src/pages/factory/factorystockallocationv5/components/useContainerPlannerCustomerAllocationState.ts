// Extracted from ./ContainerPlannerCustomerAllocation.tsx
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PlanAllocationSummary } from "@shared/containerCustomerAllocation";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readActiveCompanyScope } from "@/lib/progressivePagination";
import {
  getJson,
  type AllocationResponse,
  type PackingListResponse,
  type Props,
} from "./ContainerPlannerCustomerAllocationHelpers";

export function useContainerPlannerCustomerAllocationState({
  planId,
  onPlanChanged,
}: Pick<Props, "planId" | "onPlanChanged">) {
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
  return {
    setActiveContainerId,
    setPackingListCustomerId,
    packingListCustomerId,
    draftQty,
    setDraftQty,
    draftCustomerId,
    setDraftCustomerId,
    allocationQuery,
    packingListQuery,
    summary,
    containers,
    selectedContainerId,
    selectedContainer,
    customerOptions,
    saveMutation,
    releaseMutation,
  };
}
