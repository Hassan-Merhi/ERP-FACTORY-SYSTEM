/**
 * Container Planner Phase 4 - Physical Bale Assignment (pure logic).
 *
 * Phases 1-3 plan quantities only: "Container 1 holds 600 CWR bales". Phase 4
 * turns those quantities into named physical bales (CWR-00001 ... CWR-00600).
 *
 * Every rule that decides whether a bale may sit in a container lives here so
 * the API route, the reconciliation cleanup and the UI all agree. Nothing in
 * this module touches the database or mutates bale status: an assignment row is
 * itself the reservation, which keeps the Phase 2/3 stock picture (driven by
 * factory_bales.status = 'IN_STOCK') stable.
 */

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

function asNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function roundWeight(value: number): number {
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

function rejection(
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

/**
 * Decides, bale by bale, which of the requested bales may join the container.
 *
 * Accepting the whole batch or nothing would make a 600-bale scan session fail
 * on one stray barcode, so every bale is judged independently and the caller
 * reports the rejects back to the scanner operator.
 */
export function planBaleAssignment(
  target: ContainerAssignmentTarget,
  requested: Array<{ token: string; bale: AssignableBale | null }>
): BaleAssignmentPlan {
  const accepted: AssignableBale[] = [];
  const rejected: BaleAssignmentRejection[] = [];

  const assignedByArticle = new Map(target.assignedByArticle);
  let containerTotal = 0;
  for (const qty of assignedByArticle.values()) containerTotal += asNonNegativeInteger(qty);

  const seen = new Set<number>();

  for (const entry of requested) {
    const bale = entry.bale;
    if (!bale) {
      rejected.push(rejection(entry.token, null, "NOT_FOUND", "No bale in this company matches this code."));
      continue;
    }
    if (seen.has(bale.id)) {
      rejected.push(rejection(entry.token, bale, "DUPLICATE_IN_REQUEST", "This bale was scanned twice in one batch."));
      continue;
    }
    if (bale.assignedContainerId === target.containerId) {
      rejected.push(
        rejection(entry.token, bale, "ALREADY_ASSIGNED_HERE", "This bale is already assigned to this container.")
      );
      continue;
    }
    if (bale.assignedContainerId != null) {
      rejected.push(
        rejection(
          entry.token,
          bale,
          "ASSIGNED_TO_OTHER_CONTAINER",
          `This bale is already reserved by ${bale.assignedContainerName || "another container"}.`
        )
      );
      continue;
    }
    if (bale.status !== "IN_STOCK") {
      rejected.push(
        rejection(entry.token, bale, "NOT_IN_STOCK", `This bale is ${bale.status} and cannot be loaded from stock.`)
      );
      continue;
    }

    const planned = asNonNegativeInteger(target.plannedByArticle.get(bale.articleCode));
    if (planned <= 0) {
      rejected.push(
        rejection(
          entry.token,
          bale,
          "ARTICLE_NOT_PLANNED",
          `${bale.articleCode} is not planned for ${target.containerName}.`
        )
      );
      continue;
    }

    const alreadyAssigned = asNonNegativeInteger(assignedByArticle.get(bale.articleCode));
    if (alreadyAssigned >= planned) {
      rejected.push(
        rejection(
          entry.token,
          bale,
          "PRODUCT_QUOTA_EXCEEDED",
          `${target.containerName} already holds all ${planned} planned ${bale.articleCode} bales.`
        )
      );
      continue;
    }
    if (containerTotal >= asNonNegativeInteger(target.capacityBales)) {
      rejected.push(
        rejection(
          entry.token,
          bale,
          "CONTAINER_CAPACITY_EXCEEDED",
          `${target.containerName} is full at ${target.capacityBales} bales.`
        )
      );
      continue;
    }

    seen.add(bale.id);
    assignedByArticle.set(bale.articleCode, alreadyAssigned + 1);
    containerTotal += 1;
    accepted.push(bale);
  }

  return { accepted, rejected };
}

/**
 * Picks bales automatically for a container, newest stock last so the factory
 * ships older production first (FIFO by bale id).
 */
export function selectAutoAssignmentBales(
  target: ContainerAssignmentTarget,
  candidates: AssignableBale[]
): AssignableBale[] {
  const needByArticle = new Map<string, number>();
  let capacityLeft = asNonNegativeInteger(target.capacityBales);

  for (const [articleCode, plannedQty] of target.plannedByArticle) {
    const need = asNonNegativeInteger(plannedQty) - asNonNegativeInteger(target.assignedByArticle.get(articleCode));
    if (need > 0) needByArticle.set(articleCode, need);
  }
  for (const qty of target.assignedByArticle.values()) {
    capacityLeft -= asNonNegativeInteger(qty);
  }

  const picked: AssignableBale[] = [];
  const ordered = [...candidates].sort((a, b) => a.id - b.id);

  for (const bale of ordered) {
    if (capacityLeft <= 0) break;
    if (bale.status !== "IN_STOCK" || bale.assignedContainerId != null) continue;
    const need = needByArticle.get(bale.articleCode) ?? 0;
    if (need <= 0) continue;
    needByArticle.set(bale.articleCode, need - 1);
    capacityLeft -= 1;
    picked.push(bale);
  }

  return picked;
}

/**
 * Builds the loading-screen progress model: what each container still needs
 * before it can be called physically complete.
 */
export function buildPlanAssignmentSummary(
  containers: Array<{
    containerId: number;
    containerName: string;
    position: number;
    capacityBales: number;
    isLocked: boolean;
    lines: Array<{ articleCode: string; productName: string; plannedQty: number }>;
    assignments: Array<{ articleCode: string; weightKg: number }>;
  }>
): PlanAssignmentSummary {
  const progress: ContainerAssignmentProgress[] = containers.map((container) => {
    const assignedByArticle = new Map<string, number>();
    let assignedWeightKg = 0;
    for (const assignment of container.assignments) {
      assignedByArticle.set(assignment.articleCode, (assignedByArticle.get(assignment.articleCode) ?? 0) + 1);
      assignedWeightKg += Number.isFinite(assignment.weightKg) ? Number(assignment.weightKg) : 0;
    }

    const articleCodes = new Set<string>([
      ...container.lines.map((line) => line.articleCode),
      ...assignedByArticle.keys(),
    ]);
    const nameByArticle = new Map(container.lines.map((line) => [line.articleCode, line.productName]));
    const plannedByArticle = new Map(
      container.lines.map((line) => [line.articleCode, asNonNegativeInteger(line.plannedQty)])
    );

    const products = Array.from(articleCodes)
      .map((articleCode) => {
        const plannedQty = plannedByArticle.get(articleCode) ?? 0;
        const assignedQty = assignedByArticle.get(articleCode) ?? 0;
        return {
          articleCode,
          productName: nameByArticle.get(articleCode) || articleCode,
          plannedQty,
          assignedQty,
          remainingQty: Math.max(plannedQty - assignedQty, 0),
        };
      })
      .sort((a, b) => a.productName.localeCompare(b.productName) || a.articleCode.localeCompare(b.articleCode));

    const plannedQty = products.reduce((sum, product) => sum + product.plannedQty, 0);
    const assignedQty = products.reduce((sum, product) => sum + product.assignedQty, 0);
    const remainingQty = products.reduce((sum, product) => sum + product.remainingQty, 0);

    return {
      containerId: container.containerId,
      containerName: container.containerName,
      position: container.position,
      capacityBales: asNonNegativeInteger(container.capacityBales),
      isLocked: container.isLocked,
      plannedQty,
      assignedQty,
      remainingQty,
      assignedWeightKg: roundWeight(assignedWeightKg),
      isFullyAssigned: plannedQty > 0 && remainingQty === 0,
      products,
    };
  });

  const plannedTotal = progress.reduce((sum, container) => sum + container.plannedQty, 0);
  const assignedTotal = progress.reduce((sum, container) => sum + container.assignedQty, 0);
  const remainingTotal = progress.reduce((sum, container) => sum + container.remainingQty, 0);
  const fullyAssignedContainers = progress.filter((container) => container.isFullyAssigned).length;

  return {
    plannedTotal,
    assignedTotal,
    remainingTotal,
    assignedWeightKg: roundWeight(progress.reduce((sum, container) => sum + container.assignedWeightKg, 0)),
    fullyAssignedContainers,
    containerCount: progress.length,
    isPlanFullyAssigned: plannedTotal > 0 && remainingTotal === 0,
    containers: progress,
  };
}

/**
 * After Phase 3 rebalances a plan the planned quantities move, so some
 * assignments can end up above their container's new quota. This returns the
 * assignment ids that must be released, newest first, so the oldest scanned
 * bales keep their place.
 */
export function selectOverAssignedBaleIds(
  containers: Array<{
    containerId: number;
    plannedByArticle: Map<string, number>;
    assignments: Array<{ assignmentId: number; articleCode: string }>;
  }>
): number[] {
  const release: number[] = [];

  for (const container of containers) {
    const byArticle = new Map<string, number[]>();
    for (const assignment of container.assignments) {
      const list = byArticle.get(assignment.articleCode) ?? [];
      list.push(assignment.assignmentId);
      byArticle.set(assignment.articleCode, list);
    }

    for (const [articleCode, assignmentIds] of byArticle) {
      const planned = asNonNegativeInteger(container.plannedByArticle.get(articleCode));
      if (assignmentIds.length <= planned) continue;
      const ordered = [...assignmentIds].sort((a, b) => b - a);
      release.push(...ordered.slice(0, assignmentIds.length - planned));
    }
  }

  return release.sort((a, b) => a - b);
}
