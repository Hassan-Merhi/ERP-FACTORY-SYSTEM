// Extracted from ./ContainerPlannerSavedPlans.tsx to keep that module under the source-size cap.

export interface PlanSummary {
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

export interface PlanLine {
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

export interface PlanDetail {
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

export interface MoveSource {
  containerId: number;
  containerName: string;
  articleCode: string;
  productName: string;
  maxQty: number;
}

export interface Props {
  capacityBales: number;
  includeGarbageWipers: boolean;
  previewTotal: number;
}

export function formatQty(value: number): string {
  return Math.round(Number(value || 0)).toLocaleString();
}

export function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `container-plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || "Request failed");
  return body as T;
}
