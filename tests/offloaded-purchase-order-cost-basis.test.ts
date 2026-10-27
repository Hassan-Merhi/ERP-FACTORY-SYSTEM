import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertOffloadedPurchaseOrderChargesUnchanged,
  assertOffloadedPurchaseOrderCostBasisUnchanged,
} from "../server/routes/containers/offloadedPurchaseOrderCostBasisGuard";

const postedItems = [
  { stockItemId: 12579, quantity: "6.000", rate: "25.00", lineTotal: "150.00" },
  { stockItemId: 13011, quantity: "4.000", rate: "15.00", lineTotal: "60.00" },
];

const oldCharges = {
  freight: "4770.00",
  surcharge: "0.00",
  fumigation: "0.00",
  documentCharges: "674.00",
  discount: "0.00",
  otherCharges: "0.00",
};

describe("offloaded purchase order cost-basis integrity", () => {
  it("accepts equivalent monetary formatting and reordering without repricing", () => {
    expect(() =>
      assertOffloadedPurchaseOrderCostBasisUnchanged(postedItems, [
        { stockItemId: 13011, quantity: 4, rate: 15, lineTotal: 60 },
        { stockItemId: 12579, quantity: "6", rate: "25", lineTotal: "150" },
      ])
    ).not.toThrow();
    expect(() =>
      assertOffloadedPurchaseOrderChargesUnchanged(oldCharges, { ...oldCharges, freight: "4770" })
    ).not.toThrow();
  });

  it.each([
    [[{ stockItemId: 12579, quantity: 5, rate: 25, lineTotal: 125 }, postedItems[1]], "quantity"],
    [[{ stockItemId: 12579, quantity: 6, rate: 26, lineTotal: 156 }, postedItems[1]], "rate"],
    [[{ stockItemId: 12579, quantity: 6, rate: 25, lineTotal: 151 }, postedItems[1]], "line total"],
    [[{ stockItemId: 12580, quantity: 6, rate: 25, lineTotal: 150 }, postedItems[1]], "item swap"],
    [[postedItems[0]], "removed line"],
    [[postedItems[0], postedItems[1], postedItems[1]], "duplicate line"],
  ])("blocks a post-offload %s change (%s)", (next) => {
    expect(() => assertOffloadedPurchaseOrderCostBasisUnchanged(postedItems, next)).toThrow();
  });

  it.each([
    ["freight", "4770.01"],
    ["documentCharges", "675"],
    ["surcharge", "1"],
    ["fumigation", "1"],
    ["discount", "1"],
    ["otherCharges", "1"],
  ] as const)("blocks a changed %s from bypassing offload costing", (field, amount) => {
    expect(() =>
      assertOffloadedPurchaseOrderChargesUnchanged(oldCharges, { ...oldCharges, [field]: amount })
    ).toThrow();
  });

  it("protects both item-edit and charge-only routes inside locked transactions", () => {
    const source = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
    const itemRoute = source("server/routes/containers/purchaseOrderItemsUpdate.ts");
    const chargeRoute = source("server/routes/containers/containerFreightWriteRoutes.ts");
    expect(itemRoute).toContain("assertOffloadedPurchaseOrderCostBasisUnchanged(currentLineItems, valuedItems)");
    expect(itemRoute).toContain("assertOffloadedPurchaseOrderChargesUnchanged(lockedPO");
    expect(chargeRoute).toContain("assertOffloadedPurchaseOrderChargesUnchanged(lockedPO");
    expect(chargeRoute).toContain("lockedPO.itemsTotal");
    expect(itemRoute.indexOf("assertOffloadedPurchaseOrderCostBasisUnchanged")).toBeLessThan(
      itemRoute.indexOf("await tx.delete(poLineItems)")
    );
    expect(itemRoute).toContain('const receiptPosted = lockedContainer?.status === "OFFLOADED" || hasActiveOffload');
    expect(itemRoute).toContain("eq(containerOffloads.optional, false)");
    expect(chargeRoute).toContain("eq(containerOffloads.optional, false)");
    expect(itemRoute).toContain("Cannot change purchase currency after stock has been received.");
    expect(chargeRoute).toContain("Cannot change purchase currency after stock has been received.");
  });
});
