import { describe, expect, it } from "vitest";

import {
  buildPlanAssignmentSummary,
  normalizeBaleToken,
  parseBaleAssignmentTokens,
  planBaleAssignment,
  selectAutoAssignmentBales,
  selectOverAssignedBaleIds,
  type AssignableBale,
  type ContainerAssignmentTarget,
} from "@shared/containerBaleAssignment";

function bale(overrides: Partial<AssignableBale> & { id: number }): AssignableBale {
  return {
    baleCode: `CWR-${String(overrides.id).padStart(5, "0")}`,
    referenceNumber: `REF-${overrides.id}`,
    articleCode: "CWR",
    productName: "Coloured Wipers",
    weightKg: 25,
    status: "IN_STOCK",
    assignedContainerId: null,
    ...overrides,
  };
}

function target(overrides: Partial<ContainerAssignmentTarget> = {}): ContainerAssignmentTarget {
  return {
    containerId: 1,
    containerName: "Container 1",
    capacityBales: 3,
    isLocked: false,
    plannedByArticle: new Map([["CWR", 2]]),
    assignedByArticle: new Map(),
    ...overrides,
  };
}

describe("parseBaleAssignmentTokens", () => {
  it("keeps positive ids and uppercased codes, dropping junk and duplicates", () => {
    const parsed = parseBaleAssignmentTokens({
      baleIds: [3, "4", 0, -1, 3, "abc", 1.5],
      baleCodes: [" cwr-1 ", "CWR-1", "", 7],
    });
    expect(parsed.baleIds).toEqual([3, 4]);
    expect(parsed.baleCodes).toEqual(["CWR-1"]);
  });

  it("normalizes scanner input", () => {
    expect(normalizeBaleToken("  cwr-00042 ")).toBe("CWR-00042");
    expect(normalizeBaleToken(42)).toBe("");
  });
});

describe("planBaleAssignment", () => {
  it("accepts eligible bales up to the planned quantity for the product", () => {
    const decision = planBaleAssignment(target(), [
      { token: "CWR-00001", bale: bale({ id: 1 }) },
      { token: "CWR-00002", bale: bale({ id: 2 }) },
      { token: "CWR-00003", bale: bale({ id: 3 }) },
    ]);

    expect(decision.accepted.map((entry) => entry.id)).toEqual([1, 2]);
    expect(decision.rejected).toHaveLength(1);
    expect(decision.rejected[0].reason).toBe("PRODUCT_QUOTA_EXCEEDED");
  });

  it("never assigns one bale twice", () => {
    const duplicate = bale({ id: 5 });
    const decision = planBaleAssignment(target(), [
      { token: "CWR-00005", bale: duplicate },
      { token: "REF-5", bale: duplicate },
    ]);

    expect(decision.accepted).toHaveLength(1);
    expect(decision.rejected[0].reason).toBe("DUPLICATE_IN_REQUEST");
  });

  it("refuses bales reserved by another container", () => {
    const decision = planBaleAssignment(target(), [
      {
        token: "CWR-00009",
        bale: bale({ id: 9, assignedContainerId: 77, assignedContainerName: "Container 7" }),
      },
    ]);

    expect(decision.accepted).toHaveLength(0);
    expect(decision.rejected[0].reason).toBe("ASSIGNED_TO_OTHER_CONTAINER");
    expect(decision.rejected[0].message).toContain("Container 7");
  });

  it("refuses bales that already sit in this container, are out of stock, or unknown", () => {
    const decision = planBaleAssignment(target(), [
      { token: "CWR-00001", bale: bale({ id: 1, assignedContainerId: 1 }) },
      { token: "CWR-00002", bale: bale({ id: 2, status: "SOLD" }) },
      { token: "NOPE", bale: null },
    ]);

    expect(decision.accepted).toHaveLength(0);
    expect(decision.rejected.map((entry) => entry.reason)).toEqual([
      "ALREADY_ASSIGNED_HERE",
      "NOT_IN_STOCK",
      "NOT_FOUND",
    ]);
  });

  it("refuses products the container does not plan", () => {
    const decision = planBaleAssignment(target(), [
      { token: "WHT-1", bale: bale({ id: 11, articleCode: "WHT", productName: "White Rags" }) },
    ]);

    expect(decision.rejected[0].reason).toBe("ARTICLE_NOT_PLANNED");
  });

  it("stops at container capacity even when more product is planned", () => {
    const decision = planBaleAssignment(target({ capacityBales: 1, plannedByArticle: new Map([["CWR", 5]]) }), [
      { token: "a", bale: bale({ id: 1 }) },
      { token: "b", bale: bale({ id: 2 }) },
    ]);

    expect(decision.accepted).toHaveLength(1);
    expect(decision.rejected[0].reason).toBe("CONTAINER_CAPACITY_EXCEEDED");
  });

  it("counts bales already assigned to the container against the quota", () => {
    const decision = planBaleAssignment(target({ assignedByArticle: new Map([["CWR", 2]]) }), [
      { token: "a", bale: bale({ id: 20 }) },
    ]);

    expect(decision.accepted).toHaveLength(0);
    expect(decision.rejected[0].reason).toBe("PRODUCT_QUOTA_EXCEEDED");
  });
});

describe("selectAutoAssignmentBales", () => {
  it("fills each product up to its remaining need, oldest bale first", () => {
    const picked = selectAutoAssignmentBales(
      target({
        capacityBales: 10,
        plannedByArticle: new Map([
          ["CWR", 2],
          ["WHT", 1],
        ]),
        assignedByArticle: new Map([["CWR", 1]]),
      }),
      [
        bale({ id: 9 }),
        bale({ id: 4 }),
        bale({ id: 6 }),
        bale({ id: 7, articleCode: "WHT" }),
        bale({ id: 8, articleCode: "WHT" }),
        bale({ id: 10, articleCode: "OTHER" }),
      ]
    );

    expect(picked.map((entry) => entry.id)).toEqual([4, 7]);
  });

  it("skips reserved and out-of-stock bales and respects remaining capacity", () => {
    const picked = selectAutoAssignmentBales(
      target({ capacityBales: 2, plannedByArticle: new Map([["CWR", 5]]), assignedByArticle: new Map([["CWR", 1]]) }),
      [
        bale({ id: 1, assignedContainerId: 3 }),
        bale({ id: 2, status: "PENDING_PRESSING" }),
        bale({ id: 3 }),
        bale({ id: 4 }),
      ]
    );

    expect(picked.map((entry) => entry.id)).toEqual([3]);
  });
});

describe("buildPlanAssignmentSummary", () => {
  it("reports per-container and plan-wide loading progress", () => {
    const summary = buildPlanAssignmentSummary([
      {
        containerId: 1,
        containerName: "Container 1",
        position: 0,
        capacityBales: 3,
        isLocked: false,
        lines: [
          { articleCode: "CWR", productName: "Coloured Wipers", plannedQty: 2 },
          { articleCode: "WHT", productName: "White Rags", plannedQty: 1 },
        ],
        assignments: [
          { articleCode: "CWR", weightKg: 25.5 },
          { articleCode: "CWR", weightKg: 24.5 },
          { articleCode: "WHT", weightKg: 30 },
        ],
      },
      {
        containerId: 2,
        containerName: "Container 2",
        position: 1,
        capacityBales: 3,
        isLocked: true,
        lines: [{ articleCode: "CWR", productName: "Coloured Wipers", plannedQty: 3 }],
        assignments: [{ articleCode: "CWR", weightKg: 20 }],
      },
    ]);

    expect(summary.plannedTotal).toBe(6);
    expect(summary.assignedTotal).toBe(4);
    expect(summary.remainingTotal).toBe(2);
    expect(summary.assignedWeightKg).toBe(100);
    expect(summary.fullyAssignedContainers).toBe(1);
    expect(summary.isPlanFullyAssigned).toBe(false);
    expect(summary.containers[0].isFullyAssigned).toBe(true);
    expect(summary.containers[1].remainingQty).toBe(2);
  });

  it("surfaces assignments whose product is no longer planned as a zero-plan row", () => {
    const summary = buildPlanAssignmentSummary([
      {
        containerId: 1,
        containerName: "Container 1",
        position: 0,
        capacityBales: 5,
        isLocked: false,
        lines: [],
        assignments: [{ articleCode: "CWR", weightKg: 25 }],
      },
    ]);

    expect(summary.plannedTotal).toBe(0);
    expect(summary.assignedTotal).toBe(1);
    expect(summary.containers[0].products[0]).toMatchObject({ plannedQty: 0, assignedQty: 1, remainingQty: 0 });
  });
});

describe("selectOverAssignedBaleIds", () => {
  it("releases the newest assignments above the new quota and every unplanned product", () => {
    const release = selectOverAssignedBaleIds([
      {
        containerId: 1,
        plannedByArticle: new Map([["CWR", 1]]),
        assignments: [
          { assignmentId: 10, articleCode: "CWR" },
          { assignmentId: 11, articleCode: "CWR" },
          { assignmentId: 12, articleCode: "CWR" },
          { assignmentId: 13, articleCode: "WHT" },
        ],
      },
      {
        containerId: 2,
        plannedByArticle: new Map([["CWR", 5]]),
        assignments: [{ assignmentId: 20, articleCode: "CWR" }],
      },
    ]);

    expect(release).toEqual([11, 12, 13]);
  });

  it("returns nothing when every container is within quota", () => {
    expect(
      selectOverAssignedBaleIds([
        {
          containerId: 1,
          plannedByArticle: new Map([["CWR", 2]]),
          assignments: [{ assignmentId: 1, articleCode: "CWR" }],
        },
      ])
    ).toEqual([]);
  });
});
