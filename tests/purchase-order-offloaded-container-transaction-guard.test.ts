import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(
  path.resolve(process.cwd(), "server/routes/containers/containerFreightWriteRoutes.ts"),
  "utf8"
);
const itemsUpdate = fs.readFileSync(
  path.resolve(process.cwd(), "server/routes/containers/purchaseOrderItemsUpdate.ts"),
  "utf8"
);

describe("Wave 2 purchase-order/offload transaction boundary", () => {
  it("keeps the existing user-facing offloaded-container protection", () => {
    expect(route).toContain('container?.status === "OFFLOADED"');
    expect(route).toContain("Cannot change stock items on an offloaded container");
  });

  it("rechecks and locks the container inside the same transaction that rewrites PO items", () => {
    const transactionStart = itemsUpdate.indexOf("await db.transaction(async (tx) => {");
    expect(transactionStart).toBeGreaterThan(-1);

    const transactionBody = itemsUpdate.slice(transactionStart);
    expect(transactionBody).toContain("FOR UPDATE");
    expect(transactionBody).toContain("existingPO.containerId");
    expect(transactionBody).toContain('status === "OFFLOADED"');
    expect(transactionBody.indexOf("FOR UPDATE")).toBeLessThan(transactionBody.indexOf("tx.delete(poLineItems)"));
  });
});
