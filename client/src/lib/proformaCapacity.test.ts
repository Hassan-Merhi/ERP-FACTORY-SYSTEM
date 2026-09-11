import { describe, expect, it } from "vitest";
import { buildProformaProgress, type ProformaCapacitySnapshot } from "./proformaCapacity";

function snapshot(overrides: Partial<ProformaCapacitySnapshot> = {}): ProformaCapacitySnapshot {
  return {
    proformaId: 71,
    companyId: 12,
    customerId: 23,
    proformaName: "Test",
    proformaActive: true,
    currentOrderId: 170,
    requestedTotalQty: 42,
    currentOrderLoadedTotalQty: 5,
    siblingLoadedTotalQty: 10,
    totalConsumedQty: 15,
    remainingTotalQty: 27,
    excessTotalQty: 0,
    articles: [
      {
        articleCode: "HMD12630",
        normalizedArticleCode: "hmd12630",
        isOnProforma: true,
        requestedQty: 42,
        currentOrderLoadedQty: 5,
        siblingLoadedQty: 10,
        totalConsumedQty: 15,
        remainingQty: 27,
        excessQty: 0,
        isFulfilled: false,
        isOverloaded: false,
        productName: "Product A",
      },
    ],
    ...overrides,
  };
}

describe("buildProformaProgress", () => {
  it("uses authoritative global consumption without subtracting the current loading twice", () => {
    expect(buildProformaProgress(snapshot())).toEqual([
      expect.objectContaining({
        quantity: 42,
        loaded: 5,
        siblingLoaded: 10,
        totalLoaded: 15,
        remaining: 27,
        status: "short",
      }),
    ]);
  });

  it("preserves historical overload while flooring remaining quantity at zero", () => {
    const value = snapshot({
      remainingTotalQty: 0,
      excessTotalQty: 65,
      articles: [
        {
          articleCode: "A",
          normalizedArticleCode: "a",
          isOnProforma: true,
          requestedQty: 42,
          currentOrderLoadedQty: 5,
          siblingLoadedQty: 102,
          totalConsumedQty: 107,
          remainingQty: 0,
          excessQty: 65,
          isFulfilled: true,
          isOverloaded: true,
        },
      ],
    });
    expect(buildProformaProgress(value)[0]).toEqual(
      expect.objectContaining({ status: "overloaded", remaining: 0, excess: 65 })
    );
  });
});
