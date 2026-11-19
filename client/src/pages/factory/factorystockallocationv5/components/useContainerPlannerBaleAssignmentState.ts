// Extracted from ./ContainerPlannerBaleAssignment.tsx
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { PlanAssignmentSummary } from "@shared/containerBaleAssignment";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readActiveCompanyScope } from "@/lib/progressivePagination";

interface AssignedBale {
  assignmentId: number;
  baleId: number;
  articleCode: string;
  baleCode: string;
  productName: string;
  weightKg: number;
  assignedVia: string;
}

interface AssignmentResponse {
  planId: number;
  planName: string;
  checkedAt: string;
  summary: PlanAssignmentSummary;
  containers: Array<{ containerId: number; containerName: string; assignments: AssignedBale[] }>;
  unassignedStock: Array<{ articleCode: string; productName: string; qty: number }>;
}

interface AssignMutationResponse {
  assigned: Array<{ id: number; baleCode: string; articleCode: string }>;
  rejected: Array<{ token: string; reason: string; message: string }>;
  summary: PlanAssignmentSummary;
}

export interface Props {
  planId: number;
  onPlanChanged: () => void;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || "Request failed");
  return body as T;
}

export function useContainerPlannerBaleAssignmentState({
  planId,
  onPlanChanged,
}: Pick<Props, "planId" | "onPlanChanged">) {
  const { toast } = useToast();
  const companyScope = readActiveCompanyScope();
  const queryKey = ["/api/factory/v5/container-plans/bales", companyScope, planId] as const;

  const [activeContainerId, setActiveContainerId] = useState<number | null>(null);
  const [scanValue, setScanValue] = useState("");

  const assignmentQuery = useQuery<AssignmentResponse>({
    queryKey,
    queryFn: () => getJson(`/api/factory/v5/container-plans/${planId}/bales`),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const summary = assignmentQuery.data?.summary ?? null;
  const containers = summary?.containers ?? [];
  const selectedContainerId = activeContainerId ?? containers.find((entry) => !entry.isLocked)?.containerId ?? null;
  const selectedContainer = containers.find((entry) => entry.containerId === selectedContainerId) ?? null;
  const selectedAssignments = useMemo(
    () =>
      assignmentQuery.data?.containers.find((entry) => entry.containerId === selectedContainerId)?.assignments ?? [],
    [assignmentQuery.data, selectedContainerId]
  );

  const applyResult = (data: AssignMutationResponse, successTitle: string) => {
    queryClient.invalidateQueries({ queryKey });
    onPlanChanged();
    if (data.rejected.length > 0) {
      toast({
        title: `${data.assigned.length} assigned, ${data.rejected.length} refused`,
        description: data.rejected[0].message,
        variant: data.assigned.length === 0 ? "destructive" : undefined,
      });
      return;
    }
    toast({ title: successTitle });
  };

  const assignMutation = useMutation({
    mutationFn: async (payload: { containerId: number; baleCodes?: string[]; auto?: boolean }) => {
      const response = await apiRequest(
        "POST",
        `/api/factory/v5/container-plans/${planId}/containers/${payload.containerId}/bales`,
        { baleCodes: payload.baleCodes, auto: payload.auto }
      );
      return (await response.json()) as AssignMutationResponse;
    },
    onSuccess: (data) => applyResult(data, `${data.assigned.length} bales assigned`),
    onError: (error: Error) => toast({ title: "Could not assign", description: error.message, variant: "destructive" }),
  });

  const releaseMutation = useMutation({
    mutationFn: async (payload: { containerId: number; baleIds?: number[]; all?: boolean }) => {
      const response = await apiRequest(
        "DELETE",
        `/api/factory/v5/container-plans/${planId}/containers/${payload.containerId}/bales`,
        { baleIds: payload.baleIds, all: payload.all }
      );
      return (await response.json()) as AssignMutationResponse & { released: number };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey });
      onPlanChanged();
      toast({ title: `${data.released} bales released back to stock` });
    },
    onError: (error: Error) =>
      toast({ title: "Could not release", description: error.message, variant: "destructive" }),
  });
  return {
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
  };
}
