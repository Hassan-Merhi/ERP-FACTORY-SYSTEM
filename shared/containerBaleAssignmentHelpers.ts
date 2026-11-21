// Extracted from ./containerBaleAssignment.ts

export const MAX_BALE_ASSIGNMENT_BATCH = 1000;

export type BaleAssignmentRejectionReason =
  | "NOT_FOUND"
  | "NOT_IN_STOCK"
  | "ALREADY_ASSIGNED_HERE"
  | "ASSIGNED_TO_OTHER_CONTAINER"
  | "ARTICLE_NOT_PLANNED"
  | "PRODUCT_QUOTA_EXCEEDED"
  | "CONTAINER_CAPACITY_EXCEEDED"
  | "DUPLICATE_IN_REQUEST";

export interface AssignableBale {
  id: number;
  baleCode: string;
  referenceNumber: string;
  articleCode: string;
  productName: string;
  weightKg: number;
  status: string;
  /** Plan container this bale is already assigned to, if any. */
  assignedContainerId: number | null;
  assignedContainerName?: string | null;
}

export interface ContainerAssignmentTarget {
  containerId: number;
  containerName: string;
  capacityBales: number;
  isLocked: boolean;
  /** Planned quantity per article code for this container (Phase 1-3 output). */
  plannedByArticle: Map<string, number>;
  /** Already-assigned bale count per article code for this container. */
  assignedByArticle: Map<string, number>;
}

export interface BaleAssignmentRejection {
  token: string;
  baleId: number | null;
  baleCode: string | null;
  articleCode: string | null;
  reason: BaleAssignmentRejectionReason;
  message: string;
}

export interface BaleAssignmentPlan {
  accepted: AssignableBale[];
  rejected: BaleAssignmentRejection[];
}

export interface ContainerAssignmentProductProgress {
  articleCode: string;
  productName: string;
  plannedQty: number;
  assignedQty: number;
  remainingQty: number;
}

export interface ContainerAssignmentProgress {
  containerId: number;
  containerName: string;
  position: number;
  capacityBales: number;
  isLocked: boolean;
  plannedQty: number;
  assignedQty: number;
  remainingQty: number;
  assignedWeightKg: number;
  isFullyAssigned: boolean;
  products: ContainerAssignmentProductProgress[];
}

export interface PlanAssignmentSummary {
  plannedTotal: number;
  assignedTotal: number;
  remainingTotal: number;
  assignedWeightKg: number;
  fullyAssignedContainers: number;
  containerCount: number;
  isPlanFullyAssigned: boolean;
  containers: ContainerAssignmentProgress[];
}

export function asNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Normalizes a scanned barcode or typed bale code for comparison. */
export function normalizeBaleToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * Parses the assign request body into de-duplicated numeric ids and code
 * tokens. Scanners post codes, the search grid posts ids, and bulk assignment
 * mixes both, so a single parser keeps the route thin.
 */
export function parseBaleAssignmentTokens(input: { baleIds?: unknown; baleCodes?: unknown }): {
  baleIds: number[];
  baleCodes: string[];
} {
  const ids = new Set<number>();
  const codes = new Set<string>();

  if (Array.isArray(input.baleIds)) {
    for (const raw of input.baleIds) {
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed) && parsed > 0) ids.add(parsed);
    }
  }
  if (Array.isArray(input.baleCodes)) {
    for (const raw of input.baleCodes) {
      const token = normalizeBaleToken(raw);
      if (token) codes.add(token);
    }
  }

  return { baleIds: Array.from(ids), baleCodes: Array.from(codes) };
}

export function rejection(
  token: string,
  bale: AssignableBale | null,
  reason: BaleAssignmentRejectionReason,
  message: string
): BaleAssignmentRejection {
  return {
    token,
    baleId: bale?.id ?? null,
    baleCode: bale?.baleCode ?? null,
    articleCode: bale?.articleCode ?? null,
    reason,
    message,
  };
}
