/**
 * Container Planner Phase 7 - Smart Optimization (pure logic).
 *
 * Phases 1-3 spread every product evenly across every container, which is fair
 * but commercially useless: each container holds a little of everything, so
 * nothing can be shipped to one customer without repacking.
 *
 * Phase 7 recommends a layout instead:
 *   - customers with open orders get whole containers of their own goods first,
 *     highest priority first;
 *   - stock nobody has ordered is packed into single-product containers while a
 *     product still fills one;
 *   - the leftovers of both are merged into as few mixed containers as possible.
 *
 * This module only recommends. Nothing here writes, and the caller decides
 * whether to apply the suggestion to a draft plan.
 */

import { normalizeContainerCapacity } from "./containerPlanner";

export type SuggestedContainerKind = "CUSTOMER" | "SINGLE_PRODUCT" | "MIXED";

export interface OptimizerStockRow {
  articleCode: string;
  productName: string;
  /** Free-to-promise bales, the same figure Phase 2 plans from. */
  availableQty: number;
}

export interface OptimizerDemandRow {
  customerId: number;
  customerName: string;
  orderId: number | null;
  articleCode: string;
  productName: string;
  demandQty: number;
  /** Higher wins. Defaults to 0, after which the larger order wins. */
  priority?: number;
}

export interface SuggestedLine {
  articleCode: string;
  productName: string;
  qty: number;
}

export interface SuggestedContainer {
  index: number;
  label: string;
  kind: SuggestedContainerKind;
  customerId: number | null;
  customerName: string | null;
  totalBales: number;
  fillPercent: number;
  isFull: boolean;
  lines: SuggestedLine[];
}

export interface UnservedDemandRow {
  customerId: number;
  customerName: string;
  articleCode: string;
  productName: string;
  shortfallQty: number;
}

export interface ContainerOptimizationPlan {
  capacity: number;
  containerCount: number;
  totalBales: number;
  plannedFromDemand: number;
  plannedFromFreeStock: number;
  unusedCapacity: number;
  averageFillPercent: number;
  fullContainers: number;
  customerContainers: number;
  singleProductContainers: number;
  mixedContainers: number;
  /** Containers that hold one customer's goods and nothing else. */
  shipReadyContainers: number;
  leftoverBales: number;
  unservedDemand: UnservedDemandRow[];
  containers: SuggestedContainer[];
}

function asNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function totalOf(lines: SuggestedLine[]): number {
  return lines.reduce((sum, line) => sum + line.qty, 0);
}

/**
 * Packs lines into containers of at most `capacity`, filling each one before
 * opening the next. Products stay as contiguous as possible, which is what
 * makes a container loadable and countable by hand.
 */
export function packLinesIntoContainers(lines: SuggestedLine[], capacity: number): SuggestedLine[][] {
  const packed: SuggestedLine[][] = [];
  let current: SuggestedLine[] = [];
  let remaining = capacity;

  for (const line of lines) {
    let qtyLeft = asNonNegativeInteger(line.qty);
    while (qtyLeft > 0) {
      if (remaining === 0) {
        packed.push(current);
        current = [];
        remaining = capacity;
      }
      const take = Math.min(qtyLeft, remaining);
      const existing = current.find((entry) => entry.articleCode === line.articleCode);
      if (existing) {
        existing.qty += take;
      } else {
        current.push({ articleCode: line.articleCode, productName: line.productName, qty: take });
      }
      qtyLeft -= take;
      remaining -= take;
    }
  }

  if (current.length > 0) packed.push(current);
  return packed;
}

function sortedDemandByCustomer(demand: OptimizerDemandRow[]) {
  const byCustomer = new Map<
    number,
    { customerId: number; customerName: string; priority: number; lines: SuggestedLine[]; totalQty: number }
  >();

  for (const row of demand) {
    const qty = asNonNegativeInteger(row.demandQty);
    if (qty <= 0) continue;
    const entry = byCustomer.get(row.customerId) ?? {
      customerId: row.customerId,
      customerName: row.customerName || `Customer ${row.customerId}`,
      priority: asNonNegativeInteger(row.priority),
      lines: [],
      totalQty: 0,
    };
    entry.priority = Math.max(entry.priority, asNonNegativeInteger(row.priority));
    const existing = entry.lines.find((line) => line.articleCode === row.articleCode);
    if (existing) {
      existing.qty += qty;
    } else {
      entry.lines.push({
        articleCode: row.articleCode,
        productName: row.productName || row.articleCode,
        qty,
      });
    }
    entry.totalQty += qty;
    byCustomer.set(row.customerId, entry);
  }

  return Array.from(byCustomer.values()).sort(
    (a, b) => b.priority - a.priority || b.totalQty - a.totalQty || a.customerName.localeCompare(b.customerName)
  );
}

/**
 * Builds the recommended container layout from current free stock and open
 * customer demand. Returns a suggestion only - no plan is written.
 */
export function buildContainerOptimizationPlan(input: {
  stock: OptimizerStockRow[];
  demand?: OptimizerDemandRow[];
  capacityBales: number;
}): ContainerOptimizationPlan {
  const capacity = normalizeContainerCapacity(input.capacityBales);

  const available = new Map<string, { productName: string; qty: number }>();
  for (const row of input.stock) {
    const qty = asNonNegativeInteger(row.availableQty);
    if (qty <= 0 || !row.articleCode) continue;
    const existing = available.get(row.articleCode);
    available.set(row.articleCode, {
      productName: row.productName || existing?.productName || row.articleCode,
      qty: (existing?.qty ?? 0) + qty,
    });
  }

  const containers: SuggestedContainer[] = [];
  const tails: SuggestedLine[] = [];
  const unservedDemand: UnservedDemandRow[] = [];
  let plannedFromDemand = 0;

  // 1. Customers first, highest priority first. A customer only ever gets what
  //    stock actually exists; the rest is reported as a shortfall rather than
  //    silently promised.
  for (const customer of sortedDemandByCustomer(input.demand ?? [])) {
    const servable: SuggestedLine[] = [];
    for (const line of customer.lines) {
      const stock = available.get(line.articleCode);
      const take = Math.min(line.qty, stock?.qty ?? 0);
      if (take > 0) {
        servable.push({ articleCode: line.articleCode, productName: line.productName, qty: take });
        available.set(line.articleCode, {
          productName: stock!.productName,
          qty: stock!.qty - take,
        });
      }
      if (take < line.qty) {
        unservedDemand.push({
          customerId: customer.customerId,
          customerName: customer.customerName,
          articleCode: line.articleCode,
          productName: line.productName,
          shortfallQty: line.qty - take,
        });
      }
    }

    if (servable.length === 0) continue;
    plannedFromDemand += totalOf(servable);

    const packs = packLinesIntoContainers(servable, capacity);
    for (const pack of packs) {
      const packTotal = totalOf(pack);
      // A partial customer container is held back and merged with other
      // leftovers, so a half-empty container never leaves the factory.
      if (packTotal < capacity) {
        tails.push(...pack);
        continue;
      }
      containers.push({
        index: containers.length,
        label: `Container ${containers.length + 1}`,
        kind: "CUSTOMER",
        customerId: customer.customerId,
        customerName: customer.customerName,
        totalBales: packTotal,
        fillPercent: (packTotal / capacity) * 100,
        isFull: true,
        lines: pack,
      });
    }
  }

  // 2. Stock nobody has ordered: one product per container while it still fills
  //    one, which is the easiest kind of container to sell and to load.
  const freeRows = Array.from(available.entries())
    .map(([articleCode, entry]) => ({ articleCode, productName: entry.productName, qty: entry.qty }))
    .filter((row) => row.qty > 0)
    .sort((a, b) => b.qty - a.qty || a.productName.localeCompare(b.productName));

  let plannedFromFreeStock = 0;
  for (const row of freeRows) {
    const fullContainers = Math.floor(row.qty / capacity);
    for (let index = 0; index < fullContainers; index += 1) {
      containers.push({
        index: containers.length,
        label: `Container ${containers.length + 1}`,
        kind: "SINGLE_PRODUCT",
        customerId: null,
        customerName: null,
        totalBales: capacity,
        fillPercent: 100,
        isFull: true,
        lines: [{ articleCode: row.articleCode, productName: row.productName, qty: capacity }],
      });
    }
    plannedFromFreeStock += row.qty;
    const remainder = row.qty - fullContainers * capacity;
    if (remainder > 0) {
      tails.push({ articleCode: row.articleCode, productName: row.productName, qty: remainder });
    }
  }

  // 3. Everything left over, from both sources, merged into as few mixed
  //    containers as the arithmetic allows.
  const mergedTails = new Map<string, SuggestedLine>();
  for (const line of tails) {
    const existing = mergedTails.get(line.articleCode);
    if (existing) {
      existing.qty += line.qty;
    } else {
      mergedTails.set(line.articleCode, { ...line });
    }
  }
  const tailLines = Array.from(mergedTails.values()).sort(
    (a, b) => b.qty - a.qty || a.productName.localeCompare(b.productName)
  );

  for (const pack of packLinesIntoContainers(tailLines, capacity)) {
    const packTotal = totalOf(pack);
    containers.push({
      index: containers.length,
      label: `Container ${containers.length + 1}`,
      kind: "MIXED",
      customerId: null,
      customerName: null,
      totalBales: packTotal,
      fillPercent: (packTotal / capacity) * 100,
      isFull: packTotal >= capacity,
      lines: pack,
    });
  }

  const totalBales = containers.reduce((sum, container) => sum + container.totalBales, 0);
  const fullContainers = containers.filter((container) => container.isFull).length;
  const customerContainers = containers.filter((container) => container.kind === "CUSTOMER").length;
  const singleProductContainers = containers.filter((container) => container.kind === "SINGLE_PRODUCT").length;
  const mixedContainers = containers.filter((container) => container.kind === "MIXED").length;
  const lastContainer = containers[containers.length - 1];

  return {
    capacity,
    containerCount: containers.length,
    totalBales,
    plannedFromDemand,
    plannedFromFreeStock,
    unusedCapacity: containers.length * capacity - totalBales,
    averageFillPercent: containers.length === 0 ? 0 : (totalBales / (containers.length * capacity)) * 100,
    fullContainers,
    customerContainers,
    singleProductContainers,
    mixedContainers,
    shipReadyContainers: customerContainers,
    leftoverBales: lastContainer && !lastContainer.isFull ? lastContainer.totalBales : 0,
    unservedDemand: unservedDemand.sort(
      (a, b) => a.customerName.localeCompare(b.customerName) || a.articleCode.localeCompare(b.articleCode)
    ),
    containers,
  };
}
