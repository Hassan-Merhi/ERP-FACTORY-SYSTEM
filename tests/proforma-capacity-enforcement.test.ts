import { describe, expect, it } from "vitest";
import { buildProformaCapacitySnapshot } from "../server/routes/factory/customer-orders/proformaCapacity";
import {
  allocateRemainingProformaLines,
  evaluateProformaArticleCapacity,
  evaluateProformaLoadingAvailability,
  validateProformaCapacityAdditions,
} from "../server/routes/factory/customer-orders/proformaCapacityEnforcement";

const proforma = {
  id: 71,
  customerId: 23,
  name: "MALI 18 AUG (PROFORMA)",
  isActive: true,
  status: "ACTIVE",
};

function snapshot(options?: { active?: boolean; consumed?: number }) {
  return buildProformaCapacitySnapshot(
    { companyId: 12, proformaId: 71, currentOrderId: 170 },
    { ...proforma, isActive: options?.active ?? true },
    [
      { articleCode: "HMD12630", quantity: 2 },
      { articleCode: " hmd12630 ", quantity: 3 },
      { articleCode: "HMD11001", quantity: 2 },
    ],
    options?.consumed
      ? [{ normalizedArticleCode: "hmd12630", orderId: 154, orderStatus: "LOADING", loadedQty: options.consumed }]
      : []
  );
}

describe("Phase 2 proforma capacity enforcement", () => {
  it("accepts case/whitespace variants and enforces the aggregated article target", () => {
    const decision = evaluateProformaArticleCapacity(snapshot({ consumed: 4 }), " HmD12630 ", 1);

    expect(decision).toEqual(
      expect.objectContaining({
        allowed: true,
        reason: null,
        normalizedArticleCode: "hmd12630",
        requestedQty: 5,
        consumedQty: 4,
        remainingQty: 1,
        projectedConsumedQty: 5,
      })
    );
  });

  it("rejects a candidate that is not on the proforma", () => {
    expect(evaluateProformaArticleCapacity(snapshot(), "EXTRA", 1)).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "not_in_proforma",
        normalizedArticleCode: "extra",
        requestedQty: 0,
        remainingQty: 0,
      })
    );
  });

  it("rejects additions beyond the remaining quantity with projected totals", () => {
    expect(evaluateProformaArticleCapacity(snapshot({ consumed: 4 }), "HMD12630", 2)).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "quantity_exceeded",
        requestedAdditionalQty: 2,
        requestedQty: 5,
        consumedQty: 4,
        remainingQty: 1,
        projectedConsumedQty: 6,
      })
    );
  });

  it("groups duplicate/case-variant additions before checking capacity", () => {
    const validation = validateProformaCapacityAdditions(snapshot({ consumed: 3 }), [
      { articleCode: "HMD12630", quantity: 1 },
      { articleCode: " hmd12630 ", quantity: 2 },
      { articleCode: "HMD11001", quantity: 1 },
    ]);

    expect(validation.allowed).toBe(false);
    expect(validation.issues).toHaveLength(1);
    expect(validation.issues[0]).toEqual(
      expect.objectContaining({
        reason: "quantity_exceeded",
        normalizedArticleCode: "hmd12630",
        requestedAdditionalQty: 3,
        consumedQty: 3,
        requestedQty: 5,
      })
    );
  });

  it("permits new loadings only for the same customer while active capacity remains", () => {
    expect(evaluateProformaLoadingAvailability(snapshot({ consumed: 4 }), 23)).toEqual({
      allowed: true,
      reason: null,
      remainingTotalQty: 3,
    });
    expect(evaluateProformaLoadingAvailability(snapshot({ consumed: 4 }), 999).reason).toBe("customer_mismatch");
    expect(evaluateProformaLoadingAvailability(snapshot({ active: false }), 23).reason).toBe("inactive");
  });

  it("blocks creation when every proforma quantity is already consumed", () => {
    const exhausted = buildProformaCapacitySnapshot(
      { companyId: 12, proformaId: 71 },
      proforma,
      [{ articleCode: "A", quantity: 2 }],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "VERIFIED", loadedQty: 2 }]
    );

    expect(evaluateProformaLoadingAvailability(exhausted, 23)).toEqual({
      allowed: false,
      reason: "fully_consumed",
      remainingTotalQty: 0,
    });
  });

  it("allocates aggregate consumption once across duplicate source lines", () => {
    const capacity = buildProformaCapacitySnapshot(
      { companyId: 12, proformaId: 71 },
      proforma,
      [
        { articleCode: "A", quantity: 2 },
        { articleCode: " a ", quantity: 3 },
      ],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "LOADING", loadedQty: 4 }]
    );
    const lines = [
      { articleCode: "A", quantity: 2, pricePerBale: "10" },
      { articleCode: " a ", quantity: 3, pricePerBale: "20" },
    ];

    const allocation = allocateRemainingProformaLines(lines, capacity);

    expect(allocation.map((entry) => entry.remainingQty)).toEqual([0, 1]);
    expect(allocation.reduce((sum, entry) => sum + entry.remainingQty, 0)).toBe(capacity.remainingTotalQty);
    expect(allocation[1].line.pricePerBale).toBe("20");
  });
});
