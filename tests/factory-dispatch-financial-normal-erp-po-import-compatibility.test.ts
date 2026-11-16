/**
 * Phase 6 staged guard and importer regression tests.
 * Authored per request; DO NOT RUN tests/CI until the owner approves later.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PoImportPreviewContainer } from "../server/routes/import/po-import-preview";

const { getStockItemByCodeOrAlias } = vi.hoisted(() => ({
  getStockItemByCodeOrAlias: vi.fn(),
}));
vi.mock("../server/storage", () => ({
  storage: { getStockItemByCodeOrAlias },
}));
import {
  parseFactoryTripPoIdentity, validateFactoryDispatchPoImport,
} from "../server/routes/import/factoryDispatchPoImportGuard";

const fakeStock = { id: 33, code: "A100", name: "T-Shirts", deletedAt: null };
const fakeSupplier = { id: 7, code: "SUP-01", active: true, deletedAt: null };
function preview(): PoImportPreviewContainer {
  return {
    containerNumber: "FD-4-123-5", supplierCode: "SUP-01", itemsCount: 2,
    itemsTotal: 14.5, chargesTotal: 10.5, grandTotal: 25,
    items: [
      { poNumber: "FDPO-4-123-5", supplierCode: "SUP-01", barcode: "A100", itemName: "T-Shirts",
        quantity: 2, rate: 6, lineTotal: 12, currency: "USD", stockItemId: null },
      { poNumber: "FDPO-4-123-5", supplierCode: "SUP-01", barcode: "B200", itemName: "Jeans",
        quantity: 1, rate: 2.5, lineTotal: 2.5, currency: "USD", stockItemId: null },
    ],
    charges: { freight: 10, surcharge: 1, fumigation: 0, documentCharges: 0, discount: 0.5 },
  };
}
beforeEach(() => getStockItemByCodeOrAlias.mockReset());
describe("Factory dispatch → Normal ERP PO import compatibility", () => {
  it("recognizes canonical Factory trip identity and rejects an altered PO or missing origin", () => {
    const correct = parseFactoryTripPoIdentity("FD-4-123-5", ["FDPO-4-123-5","FDPO-4-123-5"]);
    expect(correct.errors).toEqual([]);
    expect(correct.identity).toMatchObject({ factoryCompanyId: 4, factoryOrderId: 123, factoryDispatchId: 5 });
    expect(parseFactoryTripPoIdentity("FD-4-123-5", ["FDPO-4-123-6"]).errors).toHaveLength(1);
    expect(parseFactoryTripPoIdentity("FD-4-0123-5", ["FDPO-4-0123-5"]).errors).toHaveLength(1);
    expect(parseFactoryTripPoIdentity("OTW-123", ["FDPO-4-123-5"]).errors).toHaveLength(1);
    expect(parseFactoryTripPoIdentity("OTW-123", ["MY-PO"]).identity).toBeNull();
  });

  it("allows exact code or alias, but not a product-name fallback", async () => {
    getStockItemByCodeOrAlias.mockImplementation(async (code: string) =>
      code === "A100" ? fakeStock : code === "B200"
        ? { id: 34, code: "B200", name: "Jeans", deletedAt: null } : undefined
    );
    const items = [fakeStock, { id: 34, code: "B200", name: "Jeans", deletedAt: null }];
    const ok = await validateFactoryDispatchPoImport(71, preview(), fakeSupplier as any, items as any);
    expect(ok.errors).toEqual([]);
    expect(ok.supplierTotal).toBe("25.00");
    expect(ok.resolvedItems).toEqual([
      { index: 0, stockItemId: 33, itemName: "T-Shirts" },
      { index: 1, stockItemId: 34, itemName: "Jeans" },
    ]);
    getStockItemByCodeOrAlias.mockImplementation(async (code: string) => code === "A100" ? fakeStock : undefined);
    const missing = await validateFactoryDispatchPoImport(71, preview(), fakeSupplier as any, items as any);
    expect(missing.errors.some(x => x.includes("B200") && x.includes("fallback is disabled"))).toBe(true);
  });

  it("rejects wrong supplier, duplicate articles and tampered rate/amount", async () => {
    getStockItemByCodeOrAlias.mockResolvedValue(fakeStock);
    const src = preview();
    const badSupplier = await validateFactoryDispatchPoImport(71, src, { ...fakeSupplier, code: "OTHER" } as any, [fakeStock] as any);
    expect(badSupplier.errors.some(x => x.includes("Supplier_Code"))).toBe(true);
    const mixedSupplier = preview();
    mixedSupplier.items[1].supplierCode = "DIFFERENT";
    expect((await validateFactoryDispatchPoImport(71, mixedSupplier, fakeSupplier as any, [fakeStock] as any))
      .errors.some(x => x.includes("Supplier_Code differs"))).toBe(true);
    const dup = preview();
    dup.items[1].barcode = "A100";
    expect((await validateFactoryDispatchPoImport(71, dup, fakeSupplier as any, [fakeStock] as any))
      .errors.some(x => x.includes("repeated article"))).toBe(true);
    const prices = preview();
    prices.items[0].rate = 60;
    expect((await validateFactoryDispatchPoImport(71, prices, fakeSupplier as any, [fakeStock] as any))
      .errors.some(x => x.includes("matching line total"))).toBe(true);
    const zero = preview();
    zero.items[0].quantity = -2;
    expect((await validateFactoryDispatchPoImport(71, zero, fakeSupplier as any, [fakeStock] as any))
      .errors.some(x => x.includes("positive whole number"))).toBe(true);
  });

  it("does not reject valid floating-point rounding dust in importer totals", async () => {
    const src = preview();
    src.items[0].rate = 0.1;
    src.items[0].quantity = 3;
    src.items[0].lineTotal = 0.30000000000000004;
    src.items[1].rate = 0.2;
    src.items[1].quantity = 1;
    src.items[1].lineTotal = 0.2;
    src.itemsTotal = 0.5000000000000001;
    src.charges = { freight: 0.1, surcharge: 0.2, discount: 0, fumigation: 0, documentCharges: 0 };
    src.chargesTotal = 0.30000000000000004;
    src.grandTotal = 0.8000000000000002;
    getStockItemByCodeOrAlias.mockImplementation(async (code: string) => (
      code === "A100" ? fakeStock : { id: 34, code: "B200", name: "Jeans", deletedAt: null }
    ));
    const ok = await validateFactoryDispatchPoImport(71, src, fakeSupplier as any,
      [fakeStock, { id: 34, code: "B200", name: "Jeans", deletedAt: null }] as any);
    expect(ok.errors).toEqual([]);
    expect(ok.supplierTotal).toBe("0.80");
  });

  it("guards import-at-write, not only parse or validate, and never posts automatically from Factory", () => {
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
    const importer = read("server/routes/import/po-import.ts");
    const parser = read("server/routes/bankAssetRoutes.ts");
    const exporter = read("server/routes/factory/customer-orders/loadingDispatchPoExportRoutes.ts");
    expect(parser).toContain("parseFactoryTripPoIdentity");
    expect(importer).toContain("validateFactoryDispatchPoImport(");
    expect(importer).toContain("reserveFactoryTripPoReceipt(");
    expect(importer).toContain("completeFactoryTripPoReceipt(");
    expect(importer.indexOf("reserveFactoryTripPoReceipt(")).toBeLessThan(importer.indexOf("storage.createContainer("));
    expect(importer).toContain("!factoryTripCheck.identity");
    expect(exporter).not.toContain("po-import/import");
  });

  it("enforces globally unique origin, RLS and pending reconciliation for duplicate receipts", () => {
    const receipt = fs.readFileSync(path.join(process.cwd(),
      "server/routes/import/factoryDispatchPoImportReceipt.ts"), "utf8");
    const ddl = fs.readFileSync(path.join(process.cwd(),
      "docs/sql/manual/2026-11-10-factory-dispatch-erp-po-phase6-receipts.sql"), "utf8");
    expect(receipt).toContain("PENDING_REVIEW");
    expect(receipt).toContain("ON CONFLICT DO NOTHING");
    expect(receipt).toContain("po_number=");
    expect(ddl).toContain("factory_dispatch_erp_po_receipts_origin_uq");
    expect(ddl).toContain("FORCE ROW LEVEL SECURITY");
    expect(ddl).toContain("erp_company_scope_matches(erp_company_id)");
    expect(ddl).toContain("PENDING_REVIEW");
    expect(ddl).toContain("IMPORTED");
  });
});
