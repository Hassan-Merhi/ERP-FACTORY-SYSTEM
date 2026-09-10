import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("factory loading proforma quantity alignment", () => {
  it("manual scanning delegates membership and overload decisions to the authoritative capacity engine", () => {
    const source = read("server/routes/factory/customer-orders/bale-scanning/scan.ts");
    expect(source).toContain("getProformaCapacitySnapshot(tx");
    expect(source).toContain("evaluateProformaArticleCapacity(capacity, effectiveArticleCode, 1)");
    expect(source).toContain("decision.consumedQty");
    expect(source).toContain("decision.requestedQty");
  });

  it("factory loading requests sibling-aware remaining quantities", () => {
    const source = read("client/src/pages/factory/factorycontainerloadingscan/useFactoryContainerLoadingScanModel.ts");
    expect(source).toContain("continuationFromOrderId || String(orderId)");
  });

  it("continuation remaining quantities delegate to the authoritative capacity engine", () => {
    const source = read("server/routes/factory/customer-orders/orderCrudRoutes.ts");
    expect(source).toContain("getProformaCapacitySnapshot(db");
    expect(source).toContain("allocateRemainingProformaLines(proformaLines, capacity)");
  });
});
