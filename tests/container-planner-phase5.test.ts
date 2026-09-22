import { describe, expect, it } from "vitest";

import {
  buildCustomerPackingList,
  buildPlanAllocationSummary,
  selectOverAllocatedIds,
  validateContainerAllocation,
  type ExistingAllocation,
} from "@shared/containerCustomerAllocation";

function planned(entries: Array<[string, number]>) {
  return new Map(entries.map(([articleCode, plannedQty]) => [articleCode, { productName: articleCode, plannedQty }]));
}

describe("validateContainerAllocation", () => {
  it("accepts a line that fits the container's remaining unallocated quantity", () => {
    const result = validateContainerAllocation({
      plannedByArticle: planned([["CWR", 100]]),
      existingByArticle: new Map([["CWR", 40]]),
      currentCustomerByArticle: new Map(),
      lines: [{ articleCode: "CWR", qty: 60 }],
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toEqual([{ articleCode: "CWR", productName: "CWR", qty: 60 }]);
  });

  it("counts the customer's own existing allocation as replaceable headroom", () => {
    const result = validateContainerAllocation({
      plannedByArticle: planned([["CWR", 100]]),
      existingByArticle: new Map([["CWR", 100]]),
      currentCustomerByArticle: new Map([["CWR", 100]]),
      lines: [{ articleCode: "CWR", qty: 80 }],
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].qty).toBe(80);
  });

  it("refuses more than the container still has free", () => {
    const result = validateContainerAllocation({
      plannedByArticle: planned([["CWR", 100]]),
      existingByArticle: new Map([["CWR", 70]]),
      currentCustomerByArticle: new Map(),
      lines: [{ articleCode: "CWR", qty: 40 }],
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("CONTAINER_QUANTITY_EXCEEDED");
    expect(result.rejected[0].message).toContain("30");
  });

  it("refuses products the container does not plan and invalid quantities", () => {
    const result = validateContainerAllocation({
      plannedByArticle: planned([["CWR", 10]]),
      existingByArticle: new Map(),
      currentCustomerByArticle: new Map(),
      lines: [
        { articleCode: "WHT", qty: 1 },
        { articleCode: "CWR", qty: -5 },
        { articleCode: "CWR", qty: 2.5 },
      ],
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "ARTICLE_NOT_PLANNED",
      "INVALID_QUANTITY",
      "INVALID_QUANTITY",
    ]);
  });

  it("caps an order-linked allocation at what the order still needs across containers", () => {
    const result = validateContainerAllocation({
      plannedByArticle: planned([["CWR", 100]]),
      existingByArticle: new Map(),
      currentCustomerByArticle: new Map(),
      demandByArticle: new Map([["CWR", 50]]),
      otherContainerByArticle: new Map([["CWR", 30]]),
      lines: [{ articleCode: "CWR", qty: 25 }],
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("ORDER_DEMAND_EXCEEDED");

    const fits = validateContainerAllocation({
      plannedByArticle: planned([["CWR", 100]]),
      existingByArticle: new Map(),
      currentCustomerByArticle: new Map(),
      demandByArticle: new Map([["CWR", 50]]),
      otherContainerByArticle: new Map([["CWR", 30]]),
      lines: [{ articleCode: "CWR", qty: 20 }],
    });
    expect(fits.rejected).toHaveLength(0);
  });
});

function allocation(overrides: Partial<ExistingAllocation> & { id: number }): ExistingAllocation {
  return {
    containerId: 1,
    customerId: 10,
    customerName: "Beirut Trading",
    orderId: 100,
    articleCode: "CWR",
    productName: "Coloured Wipers",
    allocatedQty: 10,
    ...overrides,
  };
}

describe("buildPlanAllocationSummary", () => {
  it("reports container coverage and customer order coverage together", () => {
    const summary = buildPlanAllocationSummary({
      containers: [
        {
          containerId: 1,
          containerName: "Container 1",
          position: 0,
          lines: [
            { articleCode: "CWR", productName: "Coloured Wipers", plannedQty: 60 },
            { articleCode: "WHT", productName: "White Rags", plannedQty: 40 },
          ],
        },
        {
          containerId: 2,
          containerName: "Container 2",
          position: 1,
          lines: [{ articleCode: "CWR", productName: "Coloured Wipers", plannedQty: 100 }],
        },
      ],
      allocations: [
        allocation({ id: 1, containerId: 1, allocatedQty: 60 }),
        allocation({ id: 2, containerId: 1, articleCode: "WHT", productName: "White Rags", allocatedQty: 40 }),
        allocation({ id: 3, containerId: 2, allocatedQty: 30 }),
      ],
      demand: [
        {
          customerId: 10,
          customerName: "Beirut Trading",
          orderId: 100,
          articleCode: "CWR",
          productName: "Coloured Wipers",
          demandQty: 120,
        },
        {
          customerId: 10,
          customerName: "Beirut Trading",
          orderId: 100,
          articleCode: "WHT",
          productName: "White Rags",
          demandQty: 40,
        },
      ],
    });

    expect(summary.plannedTotal).toBe(200);
    expect(summary.allocatedTotal).toBe(130);
    expect(summary.unallocatedTotal).toBe(70);
    expect(summary.fullyAllocatedContainers).toBe(1);
    expect(summary.containers[1].unallocatedQty).toBe(70);

    const customer = summary.customers[0];
    expect(customer.demandQty).toBe(160);
    expect(customer.allocatedQty).toBe(130);
    expect(customer.outstandingQty).toBe(30);
    expect(customer.containerCount).toBe(2);
  });

  it("flags an allocation that exceeds the customer's outstanding demand", () => {
    const summary = buildPlanAllocationSummary({
      containers: [
        {
          containerId: 1,
          containerName: "Container 1",
          position: 0,
          lines: [{ articleCode: "CWR", productName: "Coloured Wipers", plannedQty: 100 }],
        },
      ],
      allocations: [allocation({ id: 1, allocatedQty: 80 })],
      demand: [
        {
          customerId: 10,
          customerName: "Beirut Trading",
          orderId: 100,
          articleCode: "CWR",
          productName: "Coloured Wipers",
          demandQty: 50,
        },
      ],
    });

    expect(summary.customers[0].overAllocatedQty).toBe(30);
    expect(summary.customers[0].outstandingQty).toBe(0);
  });
});

describe("buildCustomerPackingList", () => {
  it("gives each customer on a shared container a distinct slice of the bales", () => {
    const containers = [
      {
        containerId: 1,
        containerName: "Container 1",
        position: 0,
        allocations: [
          { customerId: 10, articleCode: "CWR", productName: "Coloured Wipers", allocatedQty: 2 },
          { customerId: 20, articleCode: "CWR", productName: "Coloured Wipers", allocatedQty: 2 },
        ],
        assignments: [
          { articleCode: "CWR", baleCode: "CWR-00004", weightKg: 25 },
          { articleCode: "CWR", baleCode: "CWR-00001", weightKg: 25 },
          { articleCode: "CWR", baleCode: "CWR-00003", weightKg: 25 },
          { articleCode: "CWR", baleCode: "CWR-00002", weightKg: 25 },
        ],
      },
    ];

    const first = buildCustomerPackingList({ customerId: 10, containers });
    const second = buildCustomerPackingList({ customerId: 20, containers });

    expect(first.containers[0].lines[0].baleCodes).toEqual(["CWR-00001", "CWR-00002"]);
    expect(second.containers[0].lines[0].baleCodes).toEqual(["CWR-00003", "CWR-00004"]);
    expect(first.totalQty).toBe(2);
    expect(first.totalWeightKg).toBe(50);
    expect(new Set([...first.containers[0].lines[0].baleCodes, ...second.containers[0].lines[0].baleCodes]).size).toBe(4);
  });

  it("reports an allocation with no bales assigned yet as an unfilled line", () => {
    const list = buildCustomerPackingList({
      customerId: 10,
      containers: [
        {
          containerId: 1,
          containerName: "Container 1",
          position: 0,
          allocations: [{ customerId: 10, articleCode: "CWR", productName: "Coloured Wipers", allocatedQty: 5 }],
          assignments: [],
        },
      ],
    });

    expect(list.containers[0].lines[0]).toMatchObject({ allocatedQty: 5, assignedQty: 0, baleCodes: [] });
  });

  it("leaves out containers the customer has no share of", () => {
    const list = buildCustomerPackingList({
      customerId: 10,
      containers: [
        {
          containerId: 1,
          containerName: "Container 1",
          position: 0,
          allocations: [{ customerId: 99, articleCode: "CWR", productName: "Coloured Wipers", allocatedQty: 5 }],
          assignments: [],
        },
      ],
    });

    expect(list.containers).toHaveLength(0);
    expect(list.totalQty).toBe(0);
  });
});

describe("selectOverAllocatedIds", () => {
  it("trims the newest allocation and drops what no longer fits at all", () => {
    const changes = selectOverAllocatedIds([
      {
        containerId: 1,
        plannedByArticle: new Map([["CWR", 12]]),
        allocations: [
          { id: 1, articleCode: "CWR", allocatedQty: 10 },
          { id: 2, articleCode: "CWR", allocatedQty: 10 },
          { id: 3, articleCode: "CWR", allocatedQty: 10 },
          { id: 4, articleCode: "WHT", allocatedQty: 5 },
        ],
      },
    ]);

    expect(changes).toEqual([
      { id: 2, keepQty: 2 },
      { id: 3, keepQty: 0 },
      { id: 4, keepQty: 0 },
    ]);
  });

  it("returns nothing when every allocation still fits", () => {
    expect(
      selectOverAllocatedIds([
        {
          containerId: 1,
          plannedByArticle: new Map([["CWR", 20]]),
          allocations: [{ id: 1, articleCode: "CWR", allocatedQty: 20 }],
        },
      ])
    ).toEqual([]);
  });
});
