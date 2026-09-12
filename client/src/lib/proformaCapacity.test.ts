import { describe, expect, it } from "vitest";
import { buildProformaProgress, proformaCapacityArticles, type ProformaCapacitySnapshot } from "./proformaCapacity";

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
  it("shows progress for the current loading without counting sibling loadings", () => {
    expect(buildProformaProgress(snapshot())).toEqual([
      expect.objectContaining({
        quantity: 42,
        loaded: 5,
        siblingLoaded: 10,
        totalLoaded: 5,
        remaining: 37,
        status: "short",
      }),
    ]);
  });

  it("does not mark the current loading overloaded because sibling loadings exceeded the proforma", () => {
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
      expect.objectContaining({ status: "short", totalLoaded: 5, remaining: 37, excess: 0 })
    );
  });

  it("still marks a loading overloaded when that loading itself exceeds the line quantity", () => {
    const value = snapshot({
      articles: [
        {
          articleCode: "A",
          normalizedArticleCode: "a",
          isOnProforma: true,
          requestedQty: 2,
          currentOrderLoadedQty: 3,
          siblingLoadedQty: 100,
          totalConsumedQty: 103,
          remainingQty: 0,
          excessQty: 101,
          isFulfilled: true,
          isOverloaded: true,
        },
      ],
    });
    expect(buildProformaProgress(value)[0]).toEqual(
      expect.objectContaining({ status: "overloaded", totalLoaded: 3, remaining: 0, excess: 1 })
    );
  });
});

describe("proformaCapacityArticles", () => {
  it("returns the buckets of a well-formed snapshot", () => {
    const snap = snapshot();
    expect(proformaCapacityArticles(snap)).toBe(snap.articles);
  });

  it("absorbs payloads that omit the bucket list instead of throwing", () => {
    // The snapshot comes straight from res.json(), so `articles` is only
    // guaranteed by the declared type. A body without it used to crash both
    // loading scan pages while they rendered.
    const malformed = { ...snapshot(), articles: undefined } as unknown as ProformaCapacitySnapshot;
    expect(proformaCapacityArticles(malformed)).toEqual([]);
    expect(buildProformaProgress(malformed)).toEqual([]);

    const notAnArray = { ...snapshot(), articles: "nope" } as unknown as ProformaCapacitySnapshot;
    expect(proformaCapacityArticles(notAnArray)).toEqual([]);
    expect(buildProformaProgress(notAnArray)).toEqual([]);
  });

  it("treats a missing snapshot as no buckets", () => {
    expect(proformaCapacityArticles(null)).toEqual([]);
    expect(proformaCapacityArticles(undefined)).toEqual([]);
  });
});
