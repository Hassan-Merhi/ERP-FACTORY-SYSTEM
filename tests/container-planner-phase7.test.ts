import { describe, expect, it } from "vitest";

import {
  buildContainerOptimizationPlan,
  packLinesIntoContainers,
  type OptimizerDemandRow,
  type OptimizerStockRow,
} from "@shared/containerOptimizer";

function stock(rows: Array<[string, number]>): OptimizerStockRow[] {
  return rows.map(([articleCode, availableQty]) => ({
    articleCode,
    productName: `${articleCode} Product`,
    availableQty,
  }));
}

function demand(rows: Array<[number, string, string, number, number?]>): OptimizerDemandRow[] {
  return rows.map(([customerId, customerName, articleCode, demandQty, priority]) => ({
    customerId,
    customerName,
    orderId: customerId * 10,
    articleCode,
    productName: `${articleCode} Product`,
    demandQty,
    priority,
  }));
}

describe("packLinesIntoContainers", () => {
  it("fills each container before opening the next and splits a product across two", () => {
    const packs = packLinesIntoContainers(
      [
        { articleCode: "CWR", productName: "Coloured Wipers", qty: 150 },
        { articleCode: "WHT", productName: "White Rags", qty: 60 },
      ],
      100
    );

    expect(packs).toHaveLength(3);
    expect(packs[0]).toEqual([{ articleCode: "CWR", productName: "Coloured Wipers", qty: 100 }]);
    expect(packs[1]).toEqual([
      { articleCode: "CWR", productName: "Coloured Wipers", qty: 50 },
      { articleCode: "WHT", productName: "White Rags", qty: 50 },
    ]);
    expect(packs[2]).toEqual([{ articleCode: "WHT", productName: "White Rags", qty: 10 }]);
  });

  it("returns nothing for empty input", () => {
    expect(packLinesIntoContainers([], 100)).toEqual([]);
  });
});

describe("buildContainerOptimizationPlan", () => {
  it("gives ordered customers whole containers before packing free stock", () => {
    const plan = buildContainerOptimizationPlan({
      capacityBales: 100,
      stock: stock([
        ["CWR", 400],
        ["WHT", 250],
      ]),
      demand: demand([
        [1, "Lebanon Trading", "CWR", 200],
        [2, "Dubai Imports", "WHT", 100],
      ]),
    });

    const lebanon = plan.containers.filter((container) => container.customerId === 1);
    expect(lebanon).toHaveLength(2);
    expect(lebanon.every((container) => container.isFull && container.kind === "CUSTOMER")).toBe(true);
    expect(plan.containers.filter((container) => container.customerId === 2)).toHaveLength(1);

    expect(plan.plannedFromDemand).toBe(300);
    expect(plan.plannedFromFreeStock).toBe(350);
    expect(plan.totalBales).toBe(650);
    expect(plan.containerCount).toBe(7);
    expect(plan.customerContainers).toBe(3);
    expect(plan.singleProductContainers).toBe(3);
    expect(plan.mixedContainers).toBe(1);
    expect(plan.leftoverBales).toBe(50);
  });

  it("serves the higher-priority customer first when stock is short", () => {
    const plan = buildContainerOptimizationPlan({
      capacityBales: 100,
      stock: stock([["CWR", 100]]),
      demand: demand([
        [1, "Small Order", "CWR", 100, 0],
        [2, "Key Account", "CWR", 100, 5],
      ]),
    });

    expect(plan.containers[0].customerId).toBe(2);
    expect(plan.containers).toHaveLength(1);
    expect(plan.unservedDemand).toEqual([
      {
        customerId: 1,
        customerName: "Small Order",
        articleCode: "CWR",
        productName: "CWR Product",
        shortfallQty: 100,
      },
    ]);
  });

  it("falls back to the larger order when no priority is given", () => {
    const plan = buildContainerOptimizationPlan({
      capacityBales: 100,
      stock: stock([["CWR", 100]]),
      demand: demand([
        [1, "Small Order", "CWR", 40],
        [2, "Big Order", "CWR", 100],
      ]),
    });

    expect(plan.containers[0].customerId).toBe(2);
    expect(plan.unservedDemand[0].customerId).toBe(1);
    expect(plan.unservedDemand[0].shortfallQty).toBe(40);
  });

  it("merges every partial container into one mixed tail rather than shipping half-empty boxes", () => {
    const plan = buildContainerOptimizationPlan({
      capacityBales: 100,
      stock: stock([
        ["CWR", 130],
        ["WHT", 120],
      ]),
      demand: demand([
        [1, "Lebanon Trading", "CWR", 130],
        [2, "Dubai Imports", "WHT", 120],
      ]),
    });

    // Two full customer containers plus one mixed container holding both tails.
    expect(plan.containerCount).toBe(3);
    expect(plan.customerContainers).toBe(2);
    expect(plan.mixedContainers).toBe(1);
    const mixed = plan.containers[plan.containerCount - 1];
    expect(mixed.kind).toBe("MIXED");
    expect(mixed.totalBales).toBe(50);
    expect(mixed.lines.map((line) => line.articleCode).sort()).toEqual(["CWR", "WHT"]);
    expect(plan.unusedCapacity).toBe(50);
  });

  it("plans free stock alone when there is no customer demand", () => {
    const plan = buildContainerOptimizationPlan({
      capacityBales: 600,
      stock: stock([["CWR", 5000]]),
    });

    expect(plan.plannedFromDemand).toBe(0);
    expect(plan.containerCount).toBe(9);
    expect(plan.singleProductContainers).toBe(8);
    expect(plan.mixedContainers).toBe(1);
    expect(plan.containers[8].totalBales).toBe(200);
    expect(Math.round(plan.averageFillPercent)).toBe(93);
  });

  it("returns an empty plan when nothing is available", () => {
    const plan = buildContainerOptimizationPlan({
      capacityBales: 600,
      stock: stock([["CWR", 0]]),
      demand: demand([[1, "Lebanon Trading", "CWR", 100]]),
    });

    expect(plan.containerCount).toBe(0);
    expect(plan.totalBales).toBe(0);
    expect(plan.averageFillPercent).toBe(0);
    expect(plan.unservedDemand[0].shortfallQty).toBe(100);
  });

  it("never promises more of a product than is in stock", () => {
    const plan = buildContainerOptimizationPlan({
      capacityBales: 100,
      stock: stock([["CWR", 150]]),
      demand: demand([
        [1, "A", "CWR", 100],
        [2, "B", "CWR", 100],
      ]),
    });

    expect(plan.totalBales).toBe(150);
    expect(plan.plannedFromDemand).toBe(150);
    expect(plan.plannedFromFreeStock).toBe(0);
    expect(plan.unservedDemand.reduce((sum, row) => sum + row.shortfallQty, 0)).toBe(50);
  });
});
