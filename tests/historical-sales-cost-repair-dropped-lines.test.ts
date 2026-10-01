import { describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ pool: {}, db: {} }));

import {
  activeCanonicalSaleEvidence,
  canonicalMovementNumericId,
  droppedPosLineMovements,
} from "../server/services/inventory/historicalSalesCostRepair";
import {
  canonicalPosRoleFromIdempotencyKey,
  collapsedPosIssueGroup,
  createHistoricalInventoryStateFromSnapshot,
  reverseCollapsedPosIssueGroup,
  reverseHistoricalSalesRepairMovement,
  type HistoricalSalesRepairMovement,
} from "../server/services/inventory/historicalSalesCostRepairEngine";

function canonicalPos(id: number, key: string, quantity: string, unitCost: string, at: string): HistoricalSalesRepairMovement {
  return {
    movementId: `canonical:${id}`,
    companyId: 1,
    locationId: 135,
    stockItemId: 730,
    occurredAt: at,
    createdAt: at,
    sequence: id * 10 + 5,
    quantityDelta: quantity,
    unitCost,
    sourceType: "pos-sale",
    sourceId: key.split(":")[1],
    evidence: "canonical",
    canonicalPosRole: canonicalPosRoleFromIdempotencyKey("pos-sale", key),
    idempotencyKey: key,
  };
}

function saleLine(id: number, voucherId: number, quantity: string) {
  return {
    sales_item_id: id,
    voucher_id: voucherId,
    location_id: 135,
    stock_item_id: 730,
    quantity,
    total_sales: "0",
    cost_price: "0",
    total_cost: "0",
    profit: "0",
    created_at: new Date("2026-08-24T13:13:14Z"),
  };
}

describe("V41 dropped POS line restoration", () => {
  it("restores the second line of an edited sale at the original instant from line-level reversal legs", () => {
    // Production voucher 12782: lines 93306 (1) and 93307 (2); the rev0 key was
    // per item, so only -1 was journaled. The rev72 edit reversed both lines.
    const original = canonicalPos(9989, "pos-sale:12782:rev0:730", "-1.000000", "167.520000", "2026-08-24T13:13:14.825Z");
    const reversalA = canonicalPos(30863, "pos-sale:12782:rev72:reverse:730:line:93306", "1.000000", "168.830000", "2026-09-10T08:16:33.480Z");
    const reversalB = canonicalPos(30864, "pos-sale:12782:rev72:reverse:730:line:93307", "2.000000", "168.830000", "2026-09-10T08:16:33.480Z");
    const issueA = canonicalPos(30942, "pos-sale:12782:rev72:issue:730:line:1", "-1.000000", "168.830000", "2026-09-10T08:16:33.480Z");
    const issueB = canonicalPos(30943, "pos-sale:12782:rev72:issue:730:line:2", "-2.000000", "168.830000", "2026-09-10T08:16:33.480Z");

    const result = droppedPosLineMovements(1, [original, reversalA, reversalB, issueA, issueB], [
      saleLine(101714, 12782, "1"),
      saleLine(101715, 12782, "2"),
    ]);
    expect(result.movements).toHaveLength(1);
    expect(result.movements[0]).toMatchObject({
      quantityDelta: "-2.000",
      unitCost: null,
      createdAt: original.createdAt,
      canonicalPosRole: "dropped-line",
      sourceType: "pos-sale",
    });
    expect(result.movements[0].sequence).toBeGreaterThan(original.sequence);
    // The restored line sits on the same side of the checkpoint cutoff as its journal row.
    expect(canonicalMovementNumericId(result.movements[0])).toBe(9989);
    expect(result.checks[0]).toMatchObject({ code: "CANONICAL_POS_DROPPED_LINE_RESTORED", status: "pass", expected: "3.000" });
  });

  it("restores dropped lines of an unedited sale from its current lines", () => {
    const original = canonicalPos(500, "pos-sale:900:rev0:730", "-2.000000", "10.000000", "2026-08-20T10:00:00Z");
    const result = droppedPosLineMovements(1, [original], [saleLine(1, 900, "2"), saleLine(2, 900, "3"), saleLine(3, 900, "1")]);
    expect(result.movements.map((movement) => movement.quantityDelta)).toEqual(["-3.000", "-1.000"]);
  });

  it("does not restore anything without line evidence or when the journal is not the first line", () => {
    // Pre-2026-09-09 edit legs are per item too, so the original lines are unknown.
    const original = canonicalPos(600, "pos-sale:901:rev0:730", "-1.000000", "10.000000", "2026-08-20T10:00:00Z");
    const collapsedReversal = canonicalPos(700, "pos-sale:901:rev3:reverse:730", "1.000000", "10.000000", "2026-08-25T10:00:00Z");
    expect(droppedPosLineMovements(1, [original, collapsedReversal], [saleLine(1, 901, "1"), saleLine(2, 901, "2")]).movements).toHaveLength(0);

    const mismatched = canonicalPos(601, "pos-sale:902:rev0:730", "-2.000000", "10.000000", "2026-08-20T10:00:00Z");
    const result = droppedPosLineMovements(1, [mismatched], [saleLine(5, 902, "1"), saleLine(6, 902, "2")]);
    expect(result.movements).toHaveLength(0);
    expect(result.checks[0]).toMatchObject({ code: "CANONICAL_POS_DROPPED_LINE_UNPROVEN" });
  });

  it("classifies post-2026-09-26 original issue keys as sale issues", () => {
    expect(canonicalPosRoleFromIdempotencyKey("pos-sale", "pos-sale:14000:rev0:issue:730:line:2")).toBe("sale-issue");
    expect(canonicalPosRoleFromIdempotencyKey("pos-sale", "pos-sale:14000:rev3:issue:730:line:2")).toBe("edit-issue");
  });

  it("rewinds a restored line at the live stored rate", () => {
    const dropped: HistoricalSalesRepairMovement = {
      movementId: "canonical-dropped-line:9989:2",
      companyId: 1,
      locationId: 135,
      stockItemId: 730,
      occurredAt: "2026-08-24T13:13:14.825Z",
      quantityDelta: "-2.000",
      unitCost: null,
      sourceType: "pos-sale",
      sourceId: "12782",
      evidence: "canonical",
      sequence: 1,
      canonicalPosRole: "dropped-line",
    };
    // 11 @ 167.52 = 1842.72 before the line; production issues 2 at 167.52.
    const after = createHistoricalInventoryStateFromSnapshot("9", "167.52", "1507.68");
    const reversed = reverseHistoricalSalesRepairMovement(after, dropped);
    expect(reversed.reversible).toBe(true);
    if (!reversed.reversible) return;
    expect(reversed.stateBefore.quantity.toFixed(3)).toBe("11.000");
    expect(reversed.stateBefore.averageRate.toFixed(2)).toBe("167.52");
    expect(reversed.stateBefore.totalValue.toFixed(2)).toBe("1842.72");
  });

  it("inverts an original issue jointly with its restored line and pins the recorded live rate", () => {
    // Production voucher 13581 at 1/135/730: journaled 2 @ 168.82, a 3-unit
    // line dropped; the rewound state after the sale is 1 @ 168.81.
    const original = canonicalPos(25305, "pos-sale:13581:rev0:730", "-2.000000", "168.820000", "2026-09-07T14:27:31.246Z");
    const dropped = droppedPosLineMovements(1, [original], [saleLine(99052, 13581, "2"), saleLine(99053, 13581, "3")])
      .movements[0];
    const group = collapsedPosIssueGroup([dropped, original], dropped);
    expect(group.map((movement) => movement.movementId)).toEqual([dropped.movementId, original.movementId]);

    const solutions = reverseCollapsedPosIssueGroup(
      createHistoricalInventoryStateFromSnapshot("1", "168.81", "168.81"),
      group,
      10
    );
    // Generic inversion of the dropped line alone picks 168.81 and then
    // contradicts the recorded 168.82; every joint solution starts at 168.82.
    expect(solutions.length).toBeGreaterThan(1);
    for (const solution of solutions) {
      expect(solution[1].quantity.toFixed(3)).toBe("6.000");
      expect(solution[1].averageRate.toFixed(2)).toBe("168.82");
    }
    expect(solutions.map((solution) => solution[1].totalValue.toFixed(2))).toContain("1012.91");
  });

  it("finds no joint inverse when no chain reaches the recorded rate", () => {
    const original = canonicalPos(1, "pos-sale:5:rev0:730", "-1.000000", "20.000000", "2026-08-20T10:00:00Z");
    const dropped = droppedPosLineMovements(1, [original], [saleLine(1, 5, "1"), saleLine(2, 5, "1")]).movements[0];
    expect(
      reverseCollapsedPosIssueGroup(createHistoricalInventoryStateFromSnapshot("1", "10.00", "10.00"), [dropped, original])
    ).toEqual([]);
  });

  it("prices a canonical sale from its journaled lines only, not diluted by restored lines", () => {
    // Regression for runs #49-#52: the restored line counted in the quantity
    // but not in the value, so 2 @ 168.82 + 3 restored priced at 67.53.
    const original = canonicalPos(25305, "pos-sale:13581:rev0:730", "-2.000000", "168.820000", "2026-09-07T14:27:31.246Z");
    const dropped = droppedPosLineMovements(1, [original], [saleLine(99052, 13581, "2"), saleLine(99053, 13581, "3")])
      .movements;
    const evidence = activeCanonicalSaleEvidence([original, ...dropped]).get("13581:135:730")!;
    expect(evidence.latestNegativeRate?.toFixed(2)).toBe("168.82");
    expect(evidence.latestNegativeQuantity.toFixed(3)).toBe("5.000");
    expect(evidence.totalSignedQuantity.toFixed(3)).toBe("-5.000");
  });
});
