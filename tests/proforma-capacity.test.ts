import { describe, expect, it, vi } from "vitest";
import {
  buildProformaCapacitySnapshot,
  findProformaCapacityArticle,
  getProformaCapacitySnapshot,
  type ProformaCapacityExecutor,
} from "../server/routes/factory/customer-orders/proformaCapacity";

const baseProforma = {
  id: 71,
  customerId: 23,
  name: "MALI 18 AUG (PROFORMA)",
  isActive: true,
  status: "ACTIVE",
};

const options = { companyId: 12, proformaId: 71, currentOrderId: 170 };

describe("authoritative proforma capacity engine", () => {
  it("sums duplicate/case-variant proforma lines and separates current from sibling consumption", () => {
    const snapshot = buildProformaCapacitySnapshot(
      options,
      baseProforma,
      [
        { articleCode: "HMD12630", quantity: 2 },
        { articleCode: " hmd12630 ", quantity: "3" },
      ],
      [
        { normalizedArticleCode: "hmd12630", orderId: 154, orderStatus: "LOADING", loadedQty: 2 },
        { normalizedArticleCode: " HMD12630 ", orderId: 159, orderStatus: "LOADING", loadedQty: 1 },
        { normalizedArticleCode: "hmd12630", orderId: 170, orderStatus: "LOADING", loadedQty: 1 },
      ]
    );

    const article = findProformaCapacityArticle(snapshot, " HMD12630 ");
    expect(article).toEqual(
      expect.objectContaining({
        articleCode: "HMD12630",
        normalizedArticleCode: "hmd12630",
        requestedQty: 5,
        currentOrderLoadedQty: 1,
        siblingLoadedQty: 3,
        totalConsumedQty: 4,
        remainingQty: 1,
        excessQty: 0,
        contributingOrderIds: [154, 159, 170],
        siblingOrderIds: [154, 159],
        isFulfilled: false,
        isOverloaded: false,
      })
    );
    expect(snapshot).toEqual(
      expect.objectContaining({
        requestedTotalQty: 5,
        currentOrderLoadedTotalQty: 1,
        siblingLoadedTotalQty: 3,
        totalConsumedQty: 4,
        remainingTotalQty: 1,
        excessTotalQty: 0,
      })
    );
  });

  it("preserves historical overages instead of hiding them behind a zero remaining value", () => {
    const snapshot = buildProformaCapacitySnapshot(
      options,
      baseProforma,
      [{ articleCode: "HMD12630", quantity: 42 }],
      [
        { normalizedArticleCode: "hmd12630", orderId: 154, orderStatus: "LOADING", loadedQty: 60 },
        { normalizedArticleCode: "hmd12630", orderId: 159, orderStatus: "LOADING", loadedQty: 47 },
        { normalizedArticleCode: "hmd12630", orderId: 170, orderStatus: "LOADING", loadedQty: 2 },
      ]
    );

    const article = findProformaCapacityArticle(snapshot, "hmd12630")!;
    expect(article.requestedQty).toBe(42);
    expect(article.totalConsumedQty).toBe(109);
    expect(article.remainingQty).toBe(0);
    expect(article.excessQty).toBe(67);
    expect(article.isFulfilled).toBe(true);
    expect(article.isOverloaded).toBe(true);
    expect(snapshot.excessTotalQty).toBe(67);
  });

  it("keeps not-on-proforma loaded articles visible without inflating proforma capacity totals", () => {
    const snapshot = buildProformaCapacitySnapshot(
      options,
      baseProforma,
      [{ articleCode: "A", quantity: 4 }],
      [
        { normalizedArticleCode: "a", orderId: 170, orderStatus: "LOADING", loadedQty: 1 },
        { normalizedArticleCode: "EXTRA", orderId: 170, orderStatus: "LOADING", loadedQty: 2 },
      ]
    );

    const extra = findProformaCapacityArticle(snapshot, " extra ")!;
    expect(extra).toEqual(
      expect.objectContaining({
        isOnProforma: false,
        requestedQty: 0,
        currentOrderLoadedQty: 2,
        totalConsumedQty: 2,
        remainingQty: 0,
        isFulfilled: false,
        isOverloaded: false,
      })
    );
    expect(snapshot.requestedTotalQty).toBe(4);
    expect(snapshot.totalConsumedQty).toBe(1);
    expect(snapshot.loadedOutsideProformaQty).toBe(2);
  });

  it("merges repeated contribution rows for one order and clamps invalid quantities", () => {
    const snapshot = buildProformaCapacitySnapshot(
      options,
      baseProforma,
      [
        { articleCode: "A", quantity: -3 },
        { articleCode: "a", quantity: "4" },
        { articleCode: "B", quantity: "not-a-number" },
      ],
      [
        { normalizedArticleCode: "A", orderId: 170, orderStatus: "LOADING", loadedQty: 1 },
        { normalizedArticleCode: " a ", orderId: 170, orderStatus: "LOADING", loadedQty: 2 },
        { normalizedArticleCode: "A", orderId: -1, orderStatus: "LOADING", loadedQty: 99 },
        { normalizedArticleCode: "B", orderId: 159, orderStatus: "VERIFIED", loadedQty: -5 },
      ]
    );

    const articleA = findProformaCapacityArticle(snapshot, "a")!;
    expect(articleA.requestedQty).toBe(4);
    expect(articleA.currentOrderLoadedQty).toBe(3);
    expect(articleA.contributions).toHaveLength(1);
    expect(articleA.contributions[0]).toEqual(
      expect.objectContaining({ orderId: 170, loadedQty: 3, isCurrentOrder: true })
    );

    const articleB = findProformaCapacityArticle(snapshot, "b")!;
    expect(articleB.requestedQty).toBe(0);
    expect(articleB.totalConsumedQty).toBe(0);
  });

  it("reads proforma metadata, lines, and grouped loading contributions through one backend contract", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [baseProforma] })
      .mockResolvedValueOnce({ rows: [{ articleCode: "A", quantity: 5 }] })
      .mockResolvedValueOnce({
        rows: [
          { normalizedArticleCode: "a", orderId: 154, orderStatus: "VERIFIED", loadedQty: 2 },
          { normalizedArticleCode: "a", orderId: 170, orderStatus: "LOADING", loadedQty: 1 },
        ],
      });
    const executor = { execute } as unknown as ProformaCapacityExecutor;

    const snapshot = await getProformaCapacitySnapshot(executor, options);

    expect(execute).toHaveBeenCalledTimes(3);
    expect(snapshot).not.toBeNull();
    expect(findProformaCapacityArticle(snapshot!, "A")).toEqual(
      expect.objectContaining({
        requestedQty: 5,
        currentOrderLoadedQty: 1,
        siblingLoadedQty: 2,
        remainingQty: 2,
        contributingOrderIds: [154, 170],
      })
    );
  });

  it("returns null without reading lines or loading contributions when the proforma is unavailable", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [] });
    const executor = { execute } as unknown as ProformaCapacityExecutor;

    await expect(getProformaCapacitySnapshot(executor, options)).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
