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

function globalSnapshot(options?: { active?: boolean; consumed?: number }) {
  return buildProformaCapacitySnapshot(
    { companyId: 12, proformaId: 71 },
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
    const decision = evaluateProformaArticleCapacity(globalSnapshot({ consumed: 4 }), " HmD12630 ", 1, "global");

    expect(decision).toEqual(
      expect.objectContaining({
        allowed: true,
        reason: null,
        validationMode: "global",
        normalizedArticleCode: "hmd12630",
        requestedQty: 5,
        consumedQty: 4,
        remainingQty: 1,
        projectedConsumedQty: 5,
      })
    );
  });

  it("rejects an article outside the proforma when an explicit global check is requested", () => {
    expect(evaluateProformaArticleCapacity(globalSnapshot(), "EXTRA", 1, "global")).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "not_in_proforma",
        validationMode: "global",
        normalizedArticleCode: "extra",
        requestedQty: 0,
        remainingQty: 0,
      })
    );
  });

  it("keeps explicit global quantity-exceeded checks available", () => {
    expect(evaluateProformaArticleCapacity(globalSnapshot({ consumed: 4 }), "HMD12630", 2, "global")).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "quantity_exceeded",
        validationMode: "global",
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
      globalSnapshot({ consumed: 3 }),
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
    expect(evaluateProformaLoadingAvailability(globalSnapshot({ consumed: 4 }), 23)).toEqual({
      allowed: true,
      reason: null,
      remainingTotalQty: 7,
    });
    expect(evaluateProformaLoadingAvailability(globalSnapshot({ consumed: 4 }), 999).reason).toBe("customer_mismatch");
    expect(evaluateProformaLoadingAvailability(globalSnapshot({ active: false }), 23).reason).toBe("inactive");
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

describe("Phase 2 per-loading enforcement scope", () => {
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

  it("ignores sibling consumption while allowing a below-limit scan", () => {
    const capacity = buildScoped([{ orderId: 154, loadedQty: 99 }]);

    const decision = evaluateProformaArticleCapacity(capacity, "HMD12630", 1);

    expect(decision).toEqual(
      expect.objectContaining({
        allowed: true,
        reason: null,
        validationMode: "reference",
        requestedQty: 2,
        consumedQty: 0,
        remainingQty: 2,
        projectedConsumedQty: 1,
      })
    );
  });

  it("allows the scan that exactly reaches this loading's proforma quantity", () => {
    const capacity = buildScoped([
      { orderId: 154, loadedQty: 99 },
      { orderId: 170, loadedQty: 1 },
    ]);

    expect(evaluateProformaArticleCapacity(capacity, "HMD12630", 1)).toEqual(
      expect.objectContaining({
        allowed: true,
        reason: null,
        validationMode: "reference",
        requestedQty: 2,
        consumedQty: 1,
        remainingQty: 1,
        projectedConsumedQty: 2,
      })
    );
  });

  it("soft-rejects the first scan that would overload this loading", () => {
    const capacity = buildScoped([
      { orderId: 154, loadedQty: 99 },
      { orderId: 170, loadedQty: 2 },
    ]);

    expect(evaluateProformaArticleCapacity(capacity, "HMD12630", 1)).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "quantity_exceeded",
        validationMode: "reference",
        requestedQty: 2,
        consumedQty: 2,
        remainingQty: 0,
        projectedConsumedQty: 3,
      })
    );
  });

  it("soft-rejects an item outside the proforma so the existing second-scan bypass can confirm it", () => {
    const capacity = buildScoped([]);

    expect(evaluateProformaArticleCapacity(capacity, "EXTRA", 1)).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "not_in_proforma",
        validationMode: "reference",
        normalizedArticleCode: "extra",
        requestedQty: 0,
        consumedQty: 0,
        projectedConsumedQty: 1,
      })
    );
  });

  it("enforces grouped additions against this loading only", () => {
    const capacity = buildScoped([
      { orderId: 154, loadedQty: 20 },
      { orderId: 170, loadedQty: 1 },
    ]);

    const validation = validateProformaCapacityAdditions(capacity, [
      { articleCode: "HMD12630", quantity: 2 },
      { articleCode: "EXTRA", quantity: 1 },
    ]);

    expect(validation.allowed).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "quantity_exceeded", normalizedArticleCode: "hmd12630" }),
        expect.objectContaining({ reason: "not_in_proforma", normalizedArticleCode: "extra" }),
      ])
    );
  });

  it("allocates remaining lines from the current loading only for reporting helpers", () => {
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
    const decision = evaluateProformaArticleCapacity(globalSnapshot({ consumed: 2 }), "HMD12630", 4, "global");

    expect(decision).toEqual(
      expect.objectContaining({
        allowed: false,
        reason: "quantity_exceeded",
        validationMode: "global",
        consumedQty: 2,
        projectedConsumedQty: 6,
      })
    );
  });
});
