// Extracted from ./ContainerPlannerCustomerAllocation.tsx
import type { PlanAllocationSummary } from "@shared/containerCustomerAllocation";

export interface AllocationResponse {
  planId: number;
  planName: string;
  checkedAt: string;
  summary: PlanAllocationSummary;
}

export interface PackingListResponse {
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

export interface Props {
  planId: number;
  onPlanChanged: () => void;
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || "Request failed");
  return body as T;
}
