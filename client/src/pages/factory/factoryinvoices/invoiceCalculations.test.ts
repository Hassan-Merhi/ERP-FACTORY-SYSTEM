/**
 * Behavior tests for the Factory Invoices order math and grouping extracted
 * from FactoryInvoices.tsx: proforma remaining/overloaded bales, average-based
 * kg and price estimates, status tab counts, customer grouping, and the
 * drag-to-reorder persistence.
 */

import { describe, expect, it } from "vitest";
import type { CustomerOrder } from "./types";
import {
  applyCustomGroupOrder,
  computeGroupTotals,
  filterOrdersByStatus,
  getEstimatedKg,
  getEstimatedPrice,
  getOverloadedBales,
  getRemainingBales,
  groupOrdersByCustomer,
  statusFilterCounts,
} from "./invoiceCalculations";

function order(overrides: Partial<CustomerOrder>): CustomerOrder {
  return {
    id: 1,
    companyId: 1,
    customerId: 10,
    orderDate: "2026-08-01",
    status: "LOADING",
    invoiceNumber: "INV-1",
    subtotalBales: "0",
    freightAmount: "0",
    otherChargesTotal: "0",
    grandTotal: "0",
    totalQtyBales: 0,
    totalWeightKg: "0",
    proformaExpectedBales: "0",
    loadedNotInProformaBales: "0",
    customerName: "Acme",
    ...overrides,
  };
}

describe("getRemainingBales / getOverloadedBales", () => {
  it("computes bales still needed against the proforma target", () => {
    expect(getRemainingBales({ proformaExpectedBales: "40", totalQtyBales: 25 })).toBe(15);
    expect(getRemainingBales({ proformaExpectedBales: "20", totalQtyBales: 25 })).toBe(0);
  });

  it("has no expectation when the proforma target is absent or zero", () => {
    expect(getRemainingBales({ proformaExpectedBales: "0", totalQtyBales: 5 })).toBe(0);
    expect(getRemainingBales({ totalQtyBales: 5 })).toBe(0);
    expect(getRemainingBales({ proformaExpectedBales: "", totalQtyBales: 5 })).toBe(0);
  });

  it("computes overloaded bales only beyond the target", () => {
    expect(getOverloadedBales({ proformaExpectedBales: "20", totalQtyBales: 25 })).toBe(5);
    expect(getOverloadedBales({ proformaExpectedBales: "40", totalQtyBales: 25 })).toBe(0);
    expect(getOverloadedBales({ totalQtyBales: 25 })).toBe(0);
  });
});

describe("average-based estimates", () => {
  it("estimates kg and price from the order's loaded averages", () => {
    const orderA = { totalQtyBales: 20, totalWeightKg: "1000" };
    expect(getEstimatedKg(orderA, 5)).toBe(250);

    const orderP = { totalQtyBales: 10, grandTotal: "3000" };
    expect(getEstimatedPrice(orderP, 3)).toBe(900);
  });

  it("returns 0 when nothing is loaded yet (no average exists)", () => {
    expect(getEstimatedKg({ totalQtyBales: 0, totalWeightKg: "100" }, 5)).toBe(0);
    expect(getEstimatedPrice({ totalQtyBales: 0, grandTotal: "100" }, 5)).toBe(0);
  });
});

describe("status filtering and counts", () => {
  const orders = [
    order({ id: 1, status: "LOADING" }),
    order({ id: 2, status: "VERIFIED" }),
    order({ id: 3, status: "PENDING_VERIFICATION" }),
    order({ id: 4, status: "FINALIZED" }),
    order({ id: 5, status: "DRAFT" }),
  ];

  it("VERIFIED tab includes pending-verification orders", () => {
    expect(filterOrdersByStatus(orders, "VERIFIED").map((o) => o.id)).toEqual([2, 3]);
    expect(filterOrdersByStatus(orders, "LOADING").map((o) => o.id)).toEqual([1]);
    expect(filterOrdersByStatus(orders, "FINALIZED").map((o) => o.id)).toEqual([4]);
    expect(filterOrdersByStatus(orders, "ALL")).toBe(orders);
  });

  it("badge counts follow the same bucketing", () => {
    expect(statusFilterCounts(orders)).toEqual({ loading: 1, verified: 2, finalized: 1 });
  });
});

describe("groupOrdersByCustomer", () => {
  it("groups by customer preserving first-appearance order", () => {
    const groups = groupOrdersByCustomer([
      order({ id: 1, customerId: 10, customerName: "Acme" }),
      order({ id: 2, customerId: 20, customerName: "Beta" }),
      order({ id: 3, customerId: 10, customerName: "Acme" }),
      order({ id: 4, customerId: 30, customerName: "Gamma" }),
    ]);
    expect(groups.map((g) => g.customerId)).toEqual([10, 20, 30]);
    expect(groups[0].orders.map((o) => o.id)).toEqual([1, 3]);
    expect(groups[0].customerName).toBe("Acme");
  });

  it("handles an empty order list", () => {
    expect(groupOrdersByCustomer([])).toEqual([]);
  });
});

describe("applyCustomGroupOrder", () => {
  const groups = [
    { customerId: 1, customerName: "A", orders: [] },
    { customerId: 2, customerName: "B", orders: [] },
    { customerId: 3, customerName: "C", orders: [] },
  ];

  it("returns the input untouched without a custom order", () => {
    expect(applyCustomGroupOrder(groups, [])).toBe(groups);
  });

  it("reorders groups by the stored customer sequence, keeping unlisted groups at the end", () => {
    expect(applyCustomGroupOrder(groups, [3, 1]).map((g) => g.customerId)).toEqual([3, 1, 2]);
  });

  it("drops unknown ids and keeps unseen groups in original order at the end", () => {
    expect(applyCustomGroupOrder(groups, [99, 2]).map((g) => g.customerId)).toEqual([2, 1, 3]);
  });
});

describe("computeGroupTotals", () => {
  it("sums bales, weight, remaining, overloaded, and amount for the summary row", () => {
    const totals = computeGroupTotals([
      order({ id: 1, totalQtyBales: 20, totalWeightKg: "1000", proformaExpectedBales: "25", grandTotal: "5000" }),
      order({ id: 2, totalQtyBales: 30, totalWeightKg: "1500", proformaExpectedBales: "20", grandTotal: "6000" }),
    ]);
    expect(totals).toEqual({
      totalBales: 50,
      totalWeightKg: 2500,
      totalRemaining: 5, // 5 short on order 1
      totalOverloaded: 10, // 10 over on order 2
      totalAmount: 11000,
    });
  });
});
