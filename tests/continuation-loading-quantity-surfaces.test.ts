import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getRemainingBales } from "../client/src/pages/factory/factoryinvoices/invoiceCalculations";

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");

describe("continuation loading quantities across screens", () => {
  it("reads the remaining-only plan for verification, while retaining original proforma prices", () => {
    const source = read("server/routes/factory/customer-orders/verify-recover/verification-summary.ts");
    expect(source).toContain("FROM customer_order_expected_lines");
    expect(source).toContain("AND order_id = ${orderId}");
    expect(source).toContain("AND proforma_id = ${order.proformaIdUsed}");
    expect(source).toContain("expectedPlan.length");
    expect(source).toContain("expected_qty");
    expect(source).toContain("originalsById.get");
    expect(source).toContain("proformaLinesWithStock");
  });

  it("returns the continuation target in list expected quantities and precise per-article remaining", () => {
    const source = read("server/routes/factory/customer-orders/orderCrudRoutes.ts");
    expect(source).toContain("proformaExpectedBales: sql<string>");
    expect(source).toContain("SUM(expected_qty)");
    expect(source).toContain("continuationRemainingBales: sql<string | null>");
    expect(source).toContain("GREATEST(plan.expected - COALESCE(scanned.loaded, 0), 0)");
    expect(source).toContain("COUNT(DISTINCT bale_id)");
  });

  it("uses 179 instead of the original 273 for a new empty continuation", () => {
    expect(getRemainingBales({
      proformaExpectedBales: "179",
      totalQtyBales: 0,
      continuationRemainingBales: "179",
    })).toBe(179);
    expect(getRemainingBales({
      proformaExpectedBales: "273",
      totalQtyBales: 0,
      continuationRemainingBales: "179",
    })).toBe(179);
  });

  it("does not show lost-bale recovery warnings for an empty loading still in progress", () => {
    const source = read("client/src/pages/factory/FactoryPendingInvoiceVerify.tsx");
    expect(source).toContain('!["LOADING", "DRAFT"].includes(verification?.order?.status || "")');
  });
});
