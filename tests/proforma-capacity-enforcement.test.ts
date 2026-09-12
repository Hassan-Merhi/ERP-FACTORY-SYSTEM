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
  it("keeps explicit global capacity available for aggregate historical checks", () => {
    const decision = evaluateProformaArticleCapacity(snapshot({ consumed: 4 }), " HmD12630 ", 1, "global");

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

  it("keeps explicit global quantity-exceeded checks available", () => {
    expect(evaluateProformaArticleCapacity(snapshot({ consumed: 4 }), "HMD12630", 2, "global")).toEqual(
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

  it("groups duplicate/case-variant additions before an explicit global check", () => {
    const validation = validateProformaCapacityAdditions(
      snapshot({ consumed: 3 }),
      [
        { articleCode: "HMD12630", quantity: 1 },
        { articleCode: " hmd12630 ", quantity: 2 },
        { articleCode: "HMD11001", quantity: 1 },
      ],
      "global"
    );

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

  it("permits an independent new loading for the same customer while the proforma is active", () => {
    expect(evaluateProformaLoadingAvailability(snapshot({ consumed: 4 }), 23)).toEqual({
      allowed: true,
      reason: null,
      remainingTotalQty: 7,
    });
    expect(evaluateProformaLoadingAvailability(snapshot({ consumed: 4 }), 999).reason).toBe("customer_mismatch");
    expect(evaluateProformaLoadingAvailability(snapshot({ active: false }), 23).reason).toBe("inactive");
  });

  it("does not let sibling loadings exhaust a new loading", () => {
    const siblingExhausted = buildProformaCapacitySnapshot(
      { companyId: 12, proformaId: 71 },
      proforma,
      [{ articleCode: "A", quantity: 2 }],
      [{ normalizedArticleCode: "a", orderId: 154, orderStatus: "VERIFIED", loadedQty: 2 }]
    );

    expect(evaluateProformaLoadingAvailability(siblingExhausted, 23)).toEqual({
      allowed: true,
      reason: null,
      remainingTotalQty: 2,
    });
  });

  it("still supports aggregate remaining-line allocation when explicitly requested", () => {
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

    const allocation = allocateRemainingProformaLines(lines, capacity, "global");

    expect(allocation.map((entry) => entry.remainingQty)).toEqual([0, 1]);
    expect(allocation.reduce((sum, entry) => sum + entry.remainingQty, 0)).toBe(capacity.remainingTotalQty);
    expect(allocation[1].line.pricePerBale).toBe("20");
  });
});

describe("Phase 2 per-loading capacity scope", () => {
  const buildScoped = (contributions: Array<{ orderId: number; loadedQty: number }>) =>
    buildProformaCapacitySnapshot(
      { companyId: 12, proformaId: 71, currentOrderId: 170 },
      proforma,
      [{ articleCode: "HMD12630", quantity: 2 }],
      contributions.map(({ orderId, loadedQty }) => ({
        normalizedArticleCode: "hmd12630",
        orderId,
        orderStatus: "LOADING",
        loadedQty,
      }))
    );

  it("defaults to ignoring sibling containers so a fresh loading can load the full proforma quantity", () => {
    const capacity = buildScoped([{ orderId: 154, loadedQty: 2 }]);

    const decision = evaluateProformaArticleCapacity(capacity, "HMD12630", 1);

    expect(decision).toEqual(
      expect.objectContaining({
        allowed: true,
        reason: null,
        requestedQty: 2,
        consumedQty: 0,
        remainingQty: 2,
        projectedConsumedQty: 1,
      })
    );
  });

  it("still blocks when the current loading alone exceeds the proforma quantity", () => {
    const capacity = buildScoped([
      { orderId: 154, loadedQty: 5 },
      { orderId: 170, loadedQty: 2 },
    ]);

    const decision = evaluateProformaArticleCapacity(capacity, "HMD12630", 1);

    expect(decision).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "quantity_exceeded",
        requestedQty: 2,
        consumedQty: 2,
        remainingQty: 0,
        projectedConsumedQty: 3,
      })
    );
  });

  it("validates grouped additions per loading by default", () => {
    const capacity = buildScoped([{ orderId: 154, loadedQty: 20 }]);

    expect(
      validateProformaCapacityAdditions(capacity, [
        { articleCode: "HMD12630", quantity: 1 },
        { articleCode: " hmd12630 ", quantity: 1 },
      ])
    ).toEqual({ allowed: true, issues: [] });
  });

  it("allocates remaining lines from the current loading only by default", () => {
    const capacity = buildScoped([
      { orderId: 154, loadedQty: 20 },
      { orderId: 170, loadedQty: 1 },
    ]);
    const lines = [{ articleCode: "HMD12630", quantity: 2, pricePerBale: "10" }];

    expect(allocateRemainingProformaLines(lines, capacity)[0]).toEqual(
      expect.objectContaining({ consumedQty: 1, remainingQty: 1 })
    );
  });

  it("keeps explicit global scope available for historical reporting", () => {
    const capacity = buildScoped([{ orderId: 154, loadedQty: 2 }]);

    const decision = evaluateProformaArticleCapacity(capacity, "HMD12630", 1, "global");

    expect(decision).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "quantity_exceeded",
        consumedQty: 2,
        projectedConsumedQty: 3,
      })
    );
  });
});
