// Extracted from ./containerCustomerAllocation.ts

export type AllocationRejectionReason =
  "ARTICLE_NOT_PLANNED" | "CONTAINER_QUANTITY_EXCEEDED" | "ORDER_DEMAND_EXCEEDED" | "INVALID_QUANTITY";

export interface AllocationLineInput {
  articleCode: string;
  qty: number;
}

export interface ExistingAllocation {
  id: number;
  containerId: number;
  customerId: number;
  customerName: string;
  orderId: number | null;
  articleCode: string;
  productName: string;
  allocatedQty: number;
}

export interface CustomerDemandRow {
  customerId: number;
  customerName: string;
  orderId: number | null;
  articleCode: string;
  productName: string;
  demandQty: number;
}

export interface AllocationRejection {
  articleCode: string;
  requestedQty: number;
  reason: AllocationRejectionReason;
  message: string;
}

export interface AllocationValidation {
  accepted: Array<{ articleCode: string; productName: string; qty: number }>;
  rejected: AllocationRejection[];
}

export interface ContainerAllocationProduct {
  articleCode: string;
  productName: string;
  plannedQty: number;
  allocatedQty: number;
  unallocatedQty: number;
}

export interface ContainerAllocationCustomer {
  customerId: number;
  customerName: string;
  orderId: number | null;
  allocatedQty: number;
  lines: Array<{ allocationId: number; articleCode: string; productName: string; allocatedQty: number }>;
}

export interface ContainerAllocationProgress {
  containerId: number;
  containerName: string;
  position: number;
  plannedQty: number;
  allocatedQty: number;
  unallocatedQty: number;
  isFullyAllocated: boolean;
  products: ContainerAllocationProduct[];
  customers: ContainerAllocationCustomer[];
}

export interface CustomerAllocationProgress {
  customerId: number;
  customerName: string;
  demandQty: number;
  allocatedQty: number;
  outstandingQty: number;
  overAllocatedQty: number;
  containerCount: number;
  products: Array<{
    articleCode: string;
    productName: string;
    demandQty: number;
    allocatedQty: number;
    outstandingQty: number;
  }>;
}

export interface PlanAllocationSummary {
  plannedTotal: number;
  allocatedTotal: number;
  unallocatedTotal: number;
  demandTotal: number;
  outstandingDemandTotal: number;
  fullyAllocatedContainers: number;
  containerCount: number;
  containers: ContainerAllocationProgress[];
  customers: CustomerAllocationProgress[];
}

export function asNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((sum, row) => sum + pick(row), 0);
}

/**
 * Checks one customer's requested allocation against the container's planned
 * quantities and, when the customer has an order, against what that order still
 * needs. Lines are judged one by one so a partially valid request still lands.
 */
export function validateContainerAllocation(input: {
  plannedByArticle: Map<string, { productName: string; plannedQty: number }>;
  /** Allocations already recorded on this container, all customers included. */
  existingByArticle: Map<string, number>;
  /** This customer's current allocation on this container, replaced by the request. */
  currentCustomerByArticle: Map<string, number>;
  /** Remaining order demand per article for this customer across the whole plan. */
  demandByArticle?: Map<string, number>;
  /** This customer's allocation on OTHER containers, which also consumes demand. */
  otherContainerByArticle?: Map<string, number>;
  lines: AllocationLineInput[];
}): AllocationValidation {
  const accepted: AllocationValidation["accepted"] = [];
  const rejected: AllocationRejection[] = [];

  for (const line of input.lines) {
    const articleCode = typeof line.articleCode === "string" ? line.articleCode.trim() : "";
    const qty = Number(line.qty);

    if (!articleCode || !Number.isSafeInteger(qty) || qty < 0) {
      rejected.push({
        articleCode,
        requestedQty: Number(line.qty) || 0,
        reason: "INVALID_QUANTITY",
        message: "Allocation quantity must be a whole number of bales, zero or more.",
      });
      continue;
    }

    const planned = input.plannedByArticle.get(articleCode);
    if (!planned || planned.plannedQty <= 0) {
      rejected.push({
        articleCode,
        requestedQty: qty,
        reason: "ARTICLE_NOT_PLANNED",
        message: `${articleCode} is not planned for this container.`,
      });
      continue;
    }

    const otherCustomers =
      asNonNegativeInteger(input.existingByArticle.get(articleCode)) -
      asNonNegativeInteger(input.currentCustomerByArticle.get(articleCode));
    const headroom = planned.plannedQty - Math.max(otherCustomers, 0);
    if (qty > headroom) {
      rejected.push({
        articleCode,
        requestedQty: qty,
        reason: "CONTAINER_QUANTITY_EXCEEDED",
        message: `Only ${Math.max(headroom, 0)} ${articleCode} bales are still unallocated in this container.`,
      });
      continue;
    }

    if (input.demandByArticle) {
      const demand = asNonNegativeInteger(input.demandByArticle.get(articleCode));
      const elsewhere = asNonNegativeInteger(input.otherContainerByArticle?.get(articleCode));
      if (qty + elsewhere > demand) {
        rejected.push({
          articleCode,
          requestedQty: qty,
          reason: "ORDER_DEMAND_EXCEEDED",
          message: `The order needs ${demand} ${articleCode} bales and ${elsewhere} are already allocated elsewhere.`,
        });
        continue;
      }
    }

    accepted.push({ articleCode, productName: planned.productName, qty });
  }

  return { accepted, rejected };
}

export interface PackingListLine {
  articleCode: string;
  productName: string;
  allocatedQty: number;
  assignedQty: number;
  baleCodes: string[];
  weightKg: number;
}

export interface PackingListContainer {
  containerId: number;
  containerName: string;
  position: number;
  totalQty: number;
  totalWeightKg: number;
  lines: PackingListLine[];
}

/**
 * Returns allocation ids that a quantity edit has invalidated: anything above
 * the container's new planned quantity for that product, largest id first so
 * the earliest reservations survive.
 */
export function selectOverAllocatedIds(
  containers: Array<{
    containerId: number;
    plannedByArticle: Map<string, number>;
    allocations: Array<{ id: number; articleCode: string; allocatedQty: number }>;
  }>
): Array<{ id: number; keepQty: number }> {
  const changes: Array<{ id: number; keepQty: number }> = [];

  for (const container of containers) {
    const byArticle = new Map<string, Array<{ id: number; allocatedQty: number }>>();
    for (const allocation of container.allocations) {
      const list = byArticle.get(allocation.articleCode) ?? [];
      list.push({ id: allocation.id, allocatedQty: asNonNegativeInteger(allocation.allocatedQty) });
      byArticle.set(allocation.articleCode, list);
    }

    for (const [articleCode, allocations] of byArticle) {
      let budget = asNonNegativeInteger(container.plannedByArticle.get(articleCode));
      for (const allocation of [...allocations].sort((a, b) => a.id - b.id)) {
        const keepQty = Math.min(allocation.allocatedQty, budget);
        budget -= keepQty;
        if (keepQty !== allocation.allocatedQty) changes.push({ id: allocation.id, keepQty });
      }
    }
  }

  return changes.sort((a, b) => a.id - b.id);
}
