// Extracted from ./ContainerPlannerSavedPlans.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readActiveCompanyScope } from "@/lib/progressivePagination";
import {
  formatQty,
  getJson,
  requestId,
  type MoveSource,
  type PlanDetail,
  type PlanLine,
  type PlanSummary,
  type Props,
} from "./ContainerPlannerSavedPlansTypes";

export function useContainerPlannerSavedPlansState({ capacityBales, includeGarbageWipers, previewTotal }: Props) {
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
        !container.isLocked && container.id !== moveSource.containerId && container.totalBales < container.capacityBales
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
  return {
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
  };
}
