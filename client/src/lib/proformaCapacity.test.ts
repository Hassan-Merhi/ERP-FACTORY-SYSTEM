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
  it("shows live loading remaining quantity from this loading only", () => {
    expect(buildProformaProgress(snapshot())).toEqual([
      expect.objectContaining({
        quantity: 42,
        loaded: 5,
        siblingLoaded: 10,
        totalLoaded: 5,
        remaining: 37,
        excess: 0,
        fulfilled: false,
        status: "short",
      }),
    ]);
  });

  it("does not let sibling loading totals classify this loading as overloaded", () => {
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

  it("shows a current-loading overage as informational overloaded status", () => {
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
      expect.objectContaining({ status: "overloaded", totalLoaded: 3, remaining: 0, excess: 1, fulfilled: true })
    );
  });

  it("classifies loaded, less loaded, missing, and overloaded from current loading quantities", () => {
    const article = (code: string, requestedQty: number, currentOrderLoadedQty: number) => ({
      articleCode: code,
      normalizedArticleCode: code.toLowerCase(),
      isOnProforma: true,
      requestedQty,
      currentOrderLoadedQty,
      siblingLoadedQty: 99,
      totalConsumedQty: currentOrderLoadedQty + 99,
      remainingQty: 0,
      excessQty: 0,
      isFulfilled: false,
      isOverloaded: false,
    });
    const value = snapshot({
      articles: [article("LOADED", 4, 4), article("LESS", 4, 2), article("MISSING", 4, 0), article("OVER", 4, 6)],
    });

    expect(
      buildProformaProgress(value).map(({ articleCode, status, remaining, excess }) => ({
        articleCode,
        status,
        remaining,
        excess,
      }))
    ).toEqual([
      { articleCode: "LOADED", status: "fulfilled", remaining: 0, excess: 0 },
      { articleCode: "LESS", status: "short", remaining: 2, excess: 0 },
      { articleCode: "MISSING", status: "none", remaining: 4, excess: 0 },
      { articleCode: "OVER", status: "overloaded", remaining: 0, excess: 2 },
    ]);
  });
});

describe("proformaCapacityArticles", () => {
  it("returns the buckets of a well-formed snapshot", () => {
    const snap = snapshot();
    expect(proformaCapacityArticles(snap)).toBe(snap.articles);
  });

  it("absorbs payloads that omit the bucket list instead of throwing", () => {
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
