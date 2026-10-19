/**
 * Pure order math and grouping for the Factory Invoices page.
 *
 * Extracted from FactoryInvoices.tsx during the P1 god-file split. These
 * functions back the proforma-remaining column, the per-group summary row,
 * the status-tab counts, and the drag-to-reorder persistence — all of it
 * testable without rendering the table.
 */

import type { CustomerOrder, StatusFilter } from "./types";

/**
 * Date column: active loadings use the loading start timestamp; submitted and
 * finalized containers use the chosen verification submission business date.
 * UTC-noon date markers must be read as UTC dates to avoid timezone shifts.
 */
export function getFactoryInvoiceDate(
  order: Pick<
    CustomerOrder,
    "status" | "orderDate" | "loadingStartedAt" | "verifiedAt" | "loadingFinalizedAt" | "finalizedAt"
  >
): string | null {
  const toDateOnly = (raw: string | null | undefined, businessDate: boolean): string | null => {
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    if (businessDate) return date.toISOString().slice(0, 10);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  if (order.status === "LOADING" || order.status === "DRAFT") {
    return toDateOnly(order.loadingStartedAt, false) || order.orderDate || null;
  }
  if (["VERIFIED", "PENDING_VERIFICATION", "FINALIZED"].includes(order.status)) {
    return (
      toDateOnly(order.verifiedAt, true) ||
      toDateOnly(order.loadingFinalizedAt, true) ||
      (order.status === "FINALIZED" ? toDateOnly(order.finalizedAt, false) : null) ||
      order.orderDate ||
      null
    );
  }
  return order.orderDate || null;
}

export interface OrderLike {
  proformaExpectedBales?: string;
  continuationRemainingBales?: string | number | null;
  totalQtyBales: number;
}

/** How many bales still need to be loaded to meet the proforma target. */
export function getRemainingBales(order: OrderLike): number {
  // Server-calculated, article-by-article remainder is authoritative for a
  // continuation. A value of zero is valid, so do not use a truthy fallback.
  if (order.continuationRemainingBales != null) {
    return Math.max(0, Number(order.continuationRemainingBales) || 0);
  }
  const expected = parseFloat(order.proformaExpectedBales || "0");
  if (expected <= 0) return 0;
  return Math.max(0, expected - (order.totalQtyBales || 0));
}

/** Color only the loaded Bales quantities, not the Remaining column. */
export function getLoadedBalesColorClass(loadedBales: number): string {
  if (loadedBales >= 500) {
    return "inline-block rounded-md bg-emerald-700 px-2 py-0.5 text-white dark:bg-emerald-700";
  }
  if (loadedBales >= 450) {
    return "inline-block rounded-md bg-lime-100 px-2 py-0.5 text-lime-900 dark:bg-lime-900/60 dark:text-lime-200";
  }
  return "";
}

/** Bales loaded beyond the proforma target (0 when no target or under target). */
export function getOverloadedBales(order: OrderLike): number {
  const expected = parseFloat(order.proformaExpectedBales || "0");
  return expected > 0 ? Math.max(0, (order.totalQtyBales || 0) - expected) : 0;
}

/**
 * Estimate kg for `bales` more using the order's average loaded weight.
 * Returns 0 when nothing has been loaded yet (no average to extrapolate).
 */
export function getEstimatedKg(order: { totalQtyBales: number; totalWeightKg: string }, bales: number): number {
  const loaded = order.totalQtyBales || 0;
  if (loaded <= 0) return 0;
  const avgWeight = parseFloat(order.totalWeightKg || "0") / loaded;
  return bales * avgWeight;
}

/** Estimate USD price for `bales` more using the order's average bale price. */
export function getEstimatedPrice(order: { totalQtyBales: number; grandTotal: string }, bales: number): number {
  const loaded = order.totalQtyBales || 0;
  if (loaded <= 0) return 0;
  const avgPrice = parseFloat(order.grandTotal || "0") / loaded;
  return bales * avgPrice;
}

/** Orders visible in the selected status tab (VERIFIED includes pending verification). */
export function filterOrdersByStatus(orders: CustomerOrder[], statusFilter: StatusFilter): CustomerOrder[] {
  if (statusFilter === "LOADING") return orders.filter((o) => o.status === "LOADING");
  if (statusFilter === "VERIFIED")
    return orders.filter((o) => o.status === "VERIFIED" || o.status === "PENDING_VERIFICATION");
  if (statusFilter === "FINALIZED") return orders.filter((o) => o.status === "FINALIZED");
  return orders;
}

/** Badge counts for the Loading / Verified / Finalized tabs. */
export function statusFilterCounts(orders: CustomerOrder[]): {
  loading: number;
  verified: number;
  finalized: number;
} {
  return {
    loading: orders.filter((o) => o.status === "LOADING").length,
    verified: orders.filter((o) => o.status === "VERIFIED" || o.status === "PENDING_VERIFICATION").length,
    finalized: orders.filter((o) => o.status === "FINALIZED").length,
  };
}

export interface CustomerOrderGroup {
  customerId: number;
  customerName: string;
  orders: CustomerOrder[];
}

/** Group orders by customer, preserving first-appearance order. */
export function groupOrdersByCustomer(orders: CustomerOrder[]): CustomerOrderGroup[] {
  const seen = new Map<number, CustomerOrderGroup>();
  for (const order of orders) {
    if (!seen.has(order.customerId)) {
      seen.set(order.customerId, { customerId: order.customerId, customerName: order.customerName, orders: [] });
    }
    seen.get(order.customerId)!.orders.push(order);
  }
  return Array.from(seen.values());
}

/**
 * Applies a user's drag-to-reorder sequence (customerIds in display order)
 * on top of the first-appearance grouping. Unknown ids are dropped; groups
 * missing from the sequence keep their original relative order at the end.
 */
export function applyCustomGroupOrder(groups: CustomerOrderGroup[], customOrder: number[]): CustomerOrderGroup[] {
  if (!customOrder || customOrder.length === 0) return groups;
  const groupMap = new Map(groups.map((g) => [g.customerId, g]));
  const reordered = customOrder.flatMap((id) => {
    const g = groupMap.get(id);
    return g ? [g] : [];
  });
  const inOrder = new Set(customOrder);
  const extras = groups.filter((g) => !inOrder.has(g.customerId));
  return [...reordered, ...extras];
}

export interface CustomerGroupTotals {
  totalBales: number;
  totalWeightKg: number;
  totalRemaining: number;
  totalOverloaded: number;
  totalAmount: number;
}

/** Totals shown on the customer summary row of a multi-loading group. */
export function computeGroupTotals(orders: CustomerOrder[]): CustomerGroupTotals {
  return {
    totalBales: orders.reduce((s, o) => s + (o.totalQtyBales || 0), 0),
    totalWeightKg: orders.reduce((s, o) => s + parseFloat(o.totalWeightKg || "0"), 0),
    totalRemaining: orders.reduce((s, o) => s + getRemainingBales(o), 0),
    totalOverloaded: orders.reduce((s, o) => s + getOverloadedBales(o), 0),
    totalAmount: orders.reduce((s, o) => s + parseFloat(o.grandTotal || "0"), 0),
  };
}
