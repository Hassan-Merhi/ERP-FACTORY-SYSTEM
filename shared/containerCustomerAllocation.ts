/**
 * Container Planner Phase 5 - Customer Allocation (pure logic).
 *
 * Phase 4 answered "which bales are in this container". Phase 5 answers "who is
 * this container for":
 *
 *   Customer order -> container(s) -> exact bales
 *
 * One order may be split across several containers and one container may serve
 * several customers, so allocation is recorded per container, per customer, per
 * product. Everything that decides whether an allocation is legal lives here.
 */

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

function asNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
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

/**
 * Builds the Phase 5 picture from both sides: how much of each container is
 * spoken for, and how much of each customer's order is covered.
 */
export function buildPlanAllocationSummary(input: {
  containers: Array<{
    containerId: number;
    containerName: string;
    position: number;
    lines: Array<{ articleCode: string; productName: string; plannedQty: number }>;
  }>;
  allocations: ExistingAllocation[];
  demand: CustomerDemandRow[];
}): PlanAllocationSummary {
  const allocationsByContainer = new Map<number, ExistingAllocation[]>();
  for (const allocation of input.allocations) {
    const list = allocationsByContainer.get(allocation.containerId) ?? [];
    list.push(allocation);
    allocationsByContainer.set(allocation.containerId, list);
  }

  const containers: ContainerAllocationProgress[] = input.containers.map((container) => {
    const allocations = allocationsByContainer.get(container.containerId) ?? [];
    const allocatedByArticle = new Map<string, number>();
    for (const allocation of allocations) {
      allocatedByArticle.set(
        allocation.articleCode,
        (allocatedByArticle.get(allocation.articleCode) ?? 0) + asNonNegativeInteger(allocation.allocatedQty)
      );
    }

    const products = container.lines
      .map((line) => {
        const plannedQty = asNonNegativeInteger(line.plannedQty);
        const allocatedQty = allocatedByArticle.get(line.articleCode) ?? 0;
        return {
          articleCode: line.articleCode,
          productName: line.productName || line.articleCode,
          plannedQty,
          allocatedQty,
          unallocatedQty: Math.max(plannedQty - allocatedQty, 0),
        };
      })
      .sort((a, b) => a.productName.localeCompare(b.productName) || a.articleCode.localeCompare(b.articleCode));

    const byCustomer = new Map<number, ContainerAllocationCustomer>();
    for (const allocation of allocations) {
      const entry = byCustomer.get(allocation.customerId) ?? {
        customerId: allocation.customerId,
        customerName: allocation.customerName,
        orderId: allocation.orderId,
        allocatedQty: 0,
        lines: [],
      };
      entry.allocatedQty += asNonNegativeInteger(allocation.allocatedQty);
      entry.lines.push({
        allocationId: allocation.id,
        articleCode: allocation.articleCode,
        productName: allocation.productName || allocation.articleCode,
        allocatedQty: asNonNegativeInteger(allocation.allocatedQty),
      });
      byCustomer.set(allocation.customerId, entry);
    }

    const plannedQty = sumBy(products, (product) => product.plannedQty);
    const allocatedQty = sumBy(products, (product) => product.allocatedQty);

    return {
      containerId: container.containerId,
      containerName: container.containerName,
      position: container.position,
      plannedQty,
      allocatedQty,
      unallocatedQty: Math.max(plannedQty - allocatedQty, 0),
      isFullyAllocated: plannedQty > 0 && allocatedQty >= plannedQty,
      products,
      customers: Array.from(byCustomer.values()).sort((a, b) => a.customerName.localeCompare(b.customerName)),
    };
  });

  const demandByCustomer = new Map<number, Map<string, CustomerDemandRow>>();
  for (const row of input.demand) {
    const byArticle = demandByCustomer.get(row.customerId) ?? new Map<string, CustomerDemandRow>();
    const existing = byArticle.get(row.articleCode);
    byArticle.set(row.articleCode, {
      ...row,
      demandQty: asNonNegativeInteger(existing?.demandQty) + asNonNegativeInteger(row.demandQty),
    });
    demandByCustomer.set(row.customerId, byArticle);
  }

  const allocatedByCustomer = new Map<number, Map<string, { productName: string; qty: number }>>();
  const containersByCustomer = new Map<number, Set<number>>();
  const customerNames = new Map<number, string>();
  for (const allocation of input.allocations) {
    customerNames.set(allocation.customerId, allocation.customerName);
    const byArticle = allocatedByCustomer.get(allocation.customerId) ?? new Map();
    const existing = byArticle.get(allocation.articleCode);
    byArticle.set(allocation.articleCode, {
      productName: allocation.productName || allocation.articleCode,
      qty: (existing?.qty ?? 0) + asNonNegativeInteger(allocation.allocatedQty),
    });
    allocatedByCustomer.set(allocation.customerId, byArticle);

    const containerSet = containersByCustomer.get(allocation.customerId) ?? new Set<number>();
    containerSet.add(allocation.containerId);
    containersByCustomer.set(allocation.customerId, containerSet);
  }

  const customerIds = new Set<number>([...demandByCustomer.keys(), ...allocatedByCustomer.keys()]);
  const customers: CustomerAllocationProgress[] = Array.from(customerIds)
    .map((customerId) => {
      const demandArticles = demandByCustomer.get(customerId) ?? new Map<string, CustomerDemandRow>();
      const allocatedArticles = allocatedByCustomer.get(customerId) ?? new Map();
      const articleCodes = new Set<string>([...demandArticles.keys(), ...allocatedArticles.keys()]);

      const products = Array.from(articleCodes)
        .map((articleCode) => {
          const demandQty = asNonNegativeInteger(demandArticles.get(articleCode)?.demandQty);
          const allocatedQty = asNonNegativeInteger(allocatedArticles.get(articleCode)?.qty);
          return {
            articleCode,
            productName:
              demandArticles.get(articleCode)?.productName ||
              allocatedArticles.get(articleCode)?.productName ||
              articleCode,
            demandQty,
            allocatedQty,
            outstandingQty: Math.max(demandQty - allocatedQty, 0),
          };
        })
        .sort((a, b) => a.productName.localeCompare(b.productName) || a.articleCode.localeCompare(b.articleCode));

      const demandQty = sumBy(products, (product) => product.demandQty);
      const allocatedQty = sumBy(products, (product) => product.allocatedQty);

      return {
        customerId,
        customerName:
          demandArticles.values().next().value?.customerName ||
          customerNames.get(customerId) ||
          `Customer ${customerId}`,
        demandQty,
        allocatedQty,
        outstandingQty: sumBy(products, (product) => product.outstandingQty),
        overAllocatedQty: sumBy(products, (product) => Math.max(product.allocatedQty - product.demandQty, 0)),
        containerCount: containersByCustomer.get(customerId)?.size ?? 0,
        products,
      };
    })
    .sort((a, b) => a.customerName.localeCompare(b.customerName));

  const plannedTotal = sumBy(containers, (container) => container.plannedQty);
  const allocatedTotal = sumBy(containers, (container) => container.allocatedQty);

  return {
    plannedTotal,
    allocatedTotal,
    unallocatedTotal: Math.max(plannedTotal - allocatedTotal, 0),
    demandTotal: sumBy(customers, (customer) => customer.demandQty),
    outstandingDemandTotal: sumBy(customers, (customer) => customer.outstandingQty),
    fullyAllocatedContainers: containers.filter((container) => container.isFullyAllocated).length,
    containerCount: containers.length,
    containers,
    customers,
  };
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
 * Builds the customer loading / packing list: for each container reserved for a
 * customer, which products and - once Phase 4 has run - which exact bale codes
 * travel with them.
 *
 * When one container is shared by several customers, the bales of a product are
 * handed out in code order, so the same bale never appears on two packing lists.
 */
export function buildCustomerPackingList(input: {
  customerId: number;
  containers: Array<{
    containerId: number;
    containerName: string;
    position: number;
    /** Every customer's allocation on this container, ordered by customer id. */
    allocations: Array<{ customerId: number; articleCode: string; productName: string; allocatedQty: number }>;
    assignments: Array<{ articleCode: string; baleCode: string; weightKg: number }>;
  }>;
}): { containers: PackingListContainer[]; totalQty: number; totalWeightKg: number } {
  const containers: PackingListContainer[] = [];

  for (const container of input.containers) {
    const balesByArticle = new Map<string, Array<{ baleCode: string; weightKg: number }>>();
    for (const assignment of [...container.assignments].sort((a, b) => a.baleCode.localeCompare(b.baleCode))) {
      const list = balesByArticle.get(assignment.articleCode) ?? [];
      list.push({ baleCode: assignment.baleCode, weightKg: Number(assignment.weightKg) || 0 });
      balesByArticle.set(assignment.articleCode, list);
    }

    // Walk every customer on the container in a stable order so each one takes
    // a distinct slice of the physical bales.
    const cursorByArticle = new Map<string, number>();
    const lines: PackingListLine[] = [];
    const ordered = [...container.allocations].sort(
      (a, b) => a.customerId - b.customerId || a.articleCode.localeCompare(b.articleCode)
    );

    for (const allocation of ordered) {
      const qty = asNonNegativeInteger(allocation.allocatedQty);
      if (qty <= 0) continue;
      const pool = balesByArticle.get(allocation.articleCode) ?? [];
      const cursor = cursorByArticle.get(allocation.articleCode) ?? 0;
      const slice = pool.slice(cursor, cursor + qty);
      cursorByArticle.set(allocation.articleCode, cursor + qty);

      if (allocation.customerId !== input.customerId) continue;

      lines.push({
        articleCode: allocation.articleCode,
        productName: allocation.productName || allocation.articleCode,
        allocatedQty: qty,
        assignedQty: slice.length,
        baleCodes: slice.map((entry) => entry.baleCode),
        weightKg: Math.round(sumBy(slice, (entry) => entry.weightKg) * 1000) / 1000,
      });
    }

    if (lines.length === 0) continue;

    containers.push({
      containerId: container.containerId,
      containerName: container.containerName,
      position: container.position,
      totalQty: sumBy(lines, (line) => line.allocatedQty),
      totalWeightKg: Math.round(sumBy(lines, (line) => line.weightKg) * 1000) / 1000,
      lines: lines.sort((a, b) => a.productName.localeCompare(b.productName)),
    });
  }

  containers.sort((a, b) => a.position - b.position || a.containerId - b.containerId);

  return {
    containers,
    totalQty: sumBy(containers, (container) => container.totalQty),
    totalWeightKg: Math.round(sumBy(containers, (container) => container.totalWeightKg) * 1000) / 1000,
  };
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
