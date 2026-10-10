/**
 * Pure Phase 7 capacity contract; authored for Claude, never executed here.
 */
import { describe, expect, it } from "vitest";
import { getLoadingProformaProgress } from "../server/routes/factory/customer-orders/proformaCapacityEnforcement";
import type {
  ProformaCapacitySnapshot,
  ProformaCapacityArticle,
} from "../server/routes/factory/customer-orders/proformaCapacity";

function article(articleCode: string, requestedQty: number, own: number, siblings: number) {
  return {
    articleCode,
    normalizedArticleCode: articleCode.toLowerCase(),
    isOnProforma: true,
    requestedQty,
    currentOrderLoadedQty: own,
    siblingLoadedQty: siblings,
    totalConsumedQty: own + siblings,
  } as ProformaCapacityArticle;
}
function snapshot(rows: ProformaCapacityArticle[]) {
  return {
    articles: rows,
    currentOrderId: 17,
    // These represent aggregate/global numbers that must NOT control
    // whether this particular loading is fulfilled or reopened.
    requestedTotalQty: 2,
    remainingTotalQty: 0,
  } as ProformaCapacitySnapshot;
}

describe("Phase 7 per-loading completion/recovery progress", () => {
  it("does not call an empty loading complete just because a sibling filled the proforma", () => {
    expect(getLoadingProformaProgress(snapshot([article("PANT", 2, 0, 2)]))).toMatchObject({
      requestedQty: 2,
      loadedQty: 0,
      remainingQty: 2,
      satisfied: false,
    });
  });

  it("recognizes full fulfillment by the current loading even when another loading has demand", () => {
    expect(getLoadingProformaProgress(snapshot([article("PANT", 2, 2, 0)]))).toMatchObject({
      requestedQty: 2,
      loadedQty: 2,
      remainingQty: 0,
      satisfied: true,
    });
  });

  it("does not let overfilling one article hide another article's shortage", () => {
    expect(getLoadingProformaProgress(snapshot([article("PANT", 2, 5, 0), article("SHIRT", 3, 1, 0)]))).toMatchObject({
      requestedQty: 5,
      loadedQty: 6,
      remainingQty: 2,
      satisfied: false,
    });
  });

  it("does not auto-complete an empty proforma", () => {
    expect(getLoadingProformaProgress(snapshot([]))).toEqual({
      requestedQty: 0,
      loadedQty: 0,
      remainingQty: 0,
      satisfied: false,
    });
  });

  it("ignores lines absent from the linked proforma", () => {
    expect(
      getLoadingProformaProgress(
        snapshot([article("PANT", 1, 1, 3), { ...article("OTHER", 0, 100, 0), isOnProforma: false }])
      )
    ).toMatchObject({
      requestedQty: 1,
      loadedQty: 1,
      remainingQty: 0,
      satisfied: true,
    });
  });
});
