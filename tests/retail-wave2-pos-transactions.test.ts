import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  aggregateRetailCartItems,
  nextRetailReturnQuantity,
  nextRetailSaleQuantity,
  nextRetailTransferQuantities,
  validateRetailReturnQuantity,
} from "../server/services/retail/retailStockMath";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Retail POS Wave 2 transaction invariants", () => {
  it("keeps scan → cart → sale → return stock exact for the selected variant", () => {
    const scannedVariantId = 42;
    const cart = aggregateRetailCartItems([
      { variantId: scannedVariantId, quantity: 1 },
      { variantId: scannedVariantId, quantity: 1 },
    ]);

    expect(cart).toEqual([{ variantId: scannedVariantId, quantity: 2 }]);

    const stockBefore = 7;
    const stockAfterSale = nextRetailSaleQuantity(stockBefore, cart[0].quantity, false);
    expect(stockAfterSale).toBe(5);

    const newReturnedQuantity = validateRetailReturnQuantity(2, 0, 2);
    expect(newReturnedQuantity).toBe(2);

    const stockAfterReturn = nextRetailReturnQuantity(stockAfterSale, 2);
    expect(stockAfterReturn).toBe(stockBefore);
  });

  it("blocks unavailable stock unless negative stock is allowed", () => {
    expect(() => nextRetailSaleQuantity(1, 2, false)).toThrow(/Insufficient stock/);
    expect(nextRetailSaleQuantity(1, 2, true)).toBe(-1);
  });

  it("prevents over-returning the same sale item", () => {
    expect(validateRetailReturnQuantity(3, 1, 2)).toBe(3);
    expect(() => validateRetailReturnQuantity(3, 2, 2)).toThrow(/exceeds the remaining sold quantity/);
  });

  it("moves an exact quantity between two locations without changing the total", () => {
    const result = nextRetailTransferQuantities(8, 3, 2, false);
    expect(result).toEqual({ sourceAfter: 6, destinationAfter: 5 });
    expect(result.sourceAfter + result.destinationAfter).toBe(11);
  });

  it("uses database transactions and idempotency for sale, return, transfer and cancellation", () => {
    const route = read("server/routes/pos/retailPosRoutes.ts");
    const schema = read("shared/schema/retailPos.ts");

    expect(route).toContain('app.post("/api/pos/retail/sales"');
    expect(route).toContain('app.post("/api/pos/retail/sales/:saleId/returns"');
    expect(route).toContain('app.post("/api/pos/retail/transfers"');
    expect(route).toContain('app.post("/api/pos/retail/sales/:saleId/cancel"');
    expect(route.match(/db\.transaction\(/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(schema).toContain("retail_pos_sales_company_idempotency_unique");
    expect(schema).toContain("retail_pos_returns_company_idempotency_unique");
    expect(schema).toContain("retail_stock_operations_company_idempotency_unique");
    expect(schema).toContain("retail_stock_movements_company_event_unique");
  });

  it("records every required Wave 2 movement category", () => {
    const schema = read("shared/schema/retailPos.ts");
    for (const movement of [
      "sale",
      "return",
      "adjustment",
      "import",
      "transfer_out",
      "transfer_in",
      "cancellation",
      "reversal",
    ]) {
      expect(schema).toContain(`"${movement}"`);
    }
  });

  it("preserves the existing POS for non-retail companies", () => {
    const page = read("client/src/pages/pos/POSPage.tsx");
    const posIndex = read("server/routes/pos/index.ts");
    expect(page).toContain('selectedCompany?.companyType === "retail"');
    expect(page).toContain("return <POSOriginal />");
    expect(posIndex).toContain("registerPosSalesRoutes(app)");
    const legacySales = read("server/routes/pos/posSalesRoutes.ts");
    expect(legacySales).toContain('currentCoRow?.companyType === "retail"');
    expect(legacySales).toContain("RETAIL_POS_ENDPOINT_REQUIRED");
  });

  it("makes the retail POS reachable for managers and POS-role cashiers", () => {
    const appRoutes = read("client/src/routes/AppRoutes.tsx");
    const posRoutes = read("client/src/routes/PosRoutes.tsx");
    const inventory = read("client/src/pages/retail/RetailInventory.tsx");

    expect(appRoutes).toContain('location === "/retail/pos"');
    expect(appRoutes).toContain("return <RetailPOS />");
    expect(posRoutes).toContain('selectedCompany?.companyType === "retail"');
    expect(posRoutes).toContain('<Route path="/">{() => <RetailPOS />}</Route>');
    expect(posRoutes).toContain('<Route path="/pos">{() => <RetailPOS />}</Route>');
    expect(inventory).toContain('navigate("/retail/pos")');
    expect(inventory).toContain("Open POS");
  });

  it("supports exact barcode lookup and keyboard wedge scanners", () => {
    const route = read("server/routes/pos/retailPosRoutes.ts");
    const ui = read("client/src/pages/pos/RetailPOS.tsx");
    expect(route).toContain("/api/pos/retail/barcodes/:barcode");
    expect(ui).toContain('window.addEventListener("keydown"');
    expect(ui).toContain('event.key === "Enter"');
    expect(ui).toContain("scanBarcode");
  });
});
