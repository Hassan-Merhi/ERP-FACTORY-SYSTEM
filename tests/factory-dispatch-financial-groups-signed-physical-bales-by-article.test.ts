/** Phase 5 regression specifications. Authored only — NOT RUN (no CI/tests per owner). */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTripPoExport, groupFrozenTripArticles, suggestedErpPoCharges,
  tripErpContainerNumber, tripErpPoNumber, TRIP_PO_HEADERS,
  type PostedTripPoSource, type TripPoExportChoice,
} from "../server/routes/factory/customer-orders/loadingDispatchPoExportModel";
import { buildTripPoImportWorkbook } from "../server/routes/factory/customer-orders/loadingDispatchPoExportWorkbook";
import { parsePoImportSheetRows } from "../server/routes/import/poImportExcelParser";
import { readExcel, sheetToJson, writeWorkbook } from "../server/excelHelper";

const source = (): PostedTripPoSource => ({
  companyId: 12, orderId: 345, dispatchId: 8, financialId: 72, revision: 1,
  status: "POSTED", currency: "USD", sourceFingerprint: "a".repeat(64),
  goodsSubtotal: "35.00", billableChargesTotal: "20.00",
  discountTotal: "2.00", customerTotal: "53.00",
  bales: [
    { baleId: 100, articleCode: "A-100", productName: "Shirts", weightKg: "10.500", lineTotal: "12.50" },
    { baleId: 101, articleCode: "A-100", productName: "Shirts", weightKg: "11.250", lineTotal: "13.50" },
    { baleId: 102, articleCode: "B200", productName: "Jeans", weightKg: "7.000", lineTotal: "9.00" },
  ],
  charges: [
    { id: 1, name: "Freight", kind: "BILLABLE", amount: "15.00", currency: "USD", erpChargeType: "freight" },
    { id: 2, name: "Special handling", kind: "BILLABLE", amount: "5.00", currency: "USD", erpChargeType: null },
    { id: 3, name: "Customer discount", kind: "DISCOUNT", amount: "2.00", currency: "USD", erpChargeType: null },
    { id: 4, name: "Local factory transport", kind: "INTERNAL", amount: "3.00", currency: "USD", erpChargeType: null },
  ],
});
const choice = (): TripPoExportChoice => ({
  supplierCode: "SUP-ERP-001",
  rates: [{ articleCode: "B200", rate: "2.50" }, { articleCode: "A-100", rate: "6.00" }],
  charges: {
    freight: "10.00", surcharge: "1.00", fumigation: "0.00",
    discount: "0.50", documentCharges: "0.00",
  },
});
describe("Phase 5: posted Factory trip -> manual Normal ERP PO Excel", () => {
  it("groups signed physical bales by ARTICLE code rather than barcode or reference", () => {
    const actual = groupFrozenTripArticles(source());
    expect(actual).toHaveLength(2);
    expect(actual[0]).toMatchObject({
      articleCode: "A-100", quantity: 2, totalKg: "21.750", factoryGoodsValue: "26.00",
    });
    expect(actual[1]).toMatchObject({ articleCode: "B200", quantity: 1, factoryGoodsValue: "9.00" });
    const po = buildTripPoExport(source(), choice());
    expect(po.rows.map(row => row.Item_Barcode)).toEqual(["A-100", "B200"]);
    expect(po.rows[0].Quantity).toBe(2);
    expect(po.rows[0].Item_Barcode).not.toBe("100");
  });

  it("does not silently use Factory customer prices as ERP purchase costs", () => {
    const exportData = buildTripPoExport(source(), choice());
    expect(exportData.frozenFactoryCustomerTotal).toBe("53.00");
    expect(exportData.erpGoodsTotal).toBe("14.50");
    expect(exportData.erpChargesTotal).toBe("10.50");
    expect(exportData.erpSupplierInvoiceTotal).toBe("25.00");
    expect(exportData.rows[0].Rate).toBe(6);
    expect(exportData.rows[1].Rate).toBe(2.5);
  });

  it("preserves the 13 exact template headers with charge values only once", () => {
    const po = buildTripPoExport(source(), choice());
    const ws = buildTripPoImportWorkbook(po).worksheets[0];
    expect(ws.name).toBe("PO Import");
    expect(ws.getRow(1).values).toEqual([undefined, ...TRIP_PO_HEADERS]);
    expect(ws.getRow(2).getCell(9).value).toBe(10);
    expect(ws.getRow(3).getCell(9).value).toBe(0);
    expect(ws.getRow(2).getCell(12).value).toBe(0.5);
    expect(ws.getRow(3).getCell(12).value).toBe(0);
  });

  it("roundtrips through the real workbook and existing ERP PO Import parser", async () => {
    const bytes = await writeWorkbook(buildTripPoImportWorkbook(buildTripPoExport(source(), choice())));
    const workbook = await readExcel(bytes);
    const rows = sheetToJson(workbook.Sheets[workbook.SheetNames[0]]);
    const parsed = await parsePoImportSheetRows(rows, {
      allStockItems: [],
      getStockItemByCodeOrAlias: async () => undefined,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.preview).toHaveLength(1);
      expect(parsed.preview[0].containerNumber).toBe("FD-12-345-8");
      expect(parsed.preview[0].pos).toEqual(["FDPO-12-345-8"]);
      expect(parsed.preview[0].items.map(i => [i.barcode, i.quantity, i.rate]))
        .toEqual([["A-100", 2, 6], ["B200", 1, 2.5]]);
      expect(parsed.preview[0].grandTotal).toBe(25);
      expect(parsed.preview[0].charges.freight).toBe(10);
      expect(parsed.preview[0].charges.discount).toBe(0.5);
    }
  });

  it("refuses missing prices, invalid supplier, duplicated articles and malformed charges", () => {
    expect(() => buildTripPoExport(source(), {
      ...choice(), rates: [{ articleCode: "A-100", rate: "1.00" }],
    })).toThrow("purchase rate");
    expect(() => buildTripPoExport(source(), {
      ...choice(), supplierCode: "=HYPERLINK(1,2)",
    })).toThrow("supplier code");
    expect(() => buildTripPoExport(source(), {
      ...choice(), rates: [{ articleCode: "A-100", rate: "1.00" }, { articleCode: "A-100", rate: "1.00" }],
    })).toThrow("more than once");
    expect(() => buildTripPoExport(source(), {
      ...choice(), charges: { ...choice().charges, discount: "-0.20" },
    })).toThrow("charge");
  });

  it("blocks duplicate source bales and mismatching signed Factory balances", () => {
    const duplicate = source();
    duplicate.bales.push({ ...duplicate.bales[0] });
    expect(() => groupFrozenTripArticles(duplicate)).toThrow("duplicate");
    const tampered = source();
    tampered.goodsSubtotal = "36.00";
    expect(() => groupFrozenTripArticles(tampered)).toThrow("do not match");
    const tamperedCharge = source();
    tamperedCharge.billableChargesTotal = "21.00";
    expect(() => suggestedErpPoCharges(tamperedCharge)).toThrow("do not reconcile");
  });

  it("keeps immutable export identity by company/order/trip and fingerprint by reviewed ERP values", () => {
    const a = buildTripPoExport(source(), choice());
    const reordered = buildTripPoExport(source(), { ...choice(), rates: [...choice().rates].reverse() });
    expect(a.exportFingerprint).toBe(reordered.exportFingerprint);
    expect(a.containerNumber).toBe(tripErpContainerNumber(12, 345, 8));
    expect(a.poNumber).toBe(tripErpPoNumber(12, 345, 8));
    expect(tripErpContainerNumber(12, 345, 9)).not.toBe(a.containerNumber);
    expect(buildTripPoExport(source(), {
      ...choice(), rates: [{ articleCode: "A-100", rate: "6.10" }, { articleCode: "B200", rate: "2.50" }],
    }).exportFingerprint).not.toBe(a.exportFingerprint);
  });

  it("exports no internal expense and warns of unmapped customer-billable charges", () => {
    const values = suggestedErpPoCharges(source());
    expect(values.charges.freight).toBe("15.00");
    expect(values.charges.discount).toBe("2.00");
    expect(values.internalExpenseTotal).toBe("3.00");
    expect(values.unmappedBillableCharges.map(c => c.name)).toEqual(["Special handling"]);
  });

  it("requires one saved export per trip and never creates ERP accounting entries", () => {
    const at = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
    const sql = at("docs/sql/manual/2026-11-10-factory-dispatch-trip-financial-phase5-export.sql");
    const routes = at("server/routes/factory/customer-orders/loadingDispatchPoExportRoutes.ts");
    const guards = at("server/services/factory/dispatchTripFinancialPosting.ts");
    expect(sql).toContain("factory_dispatch_trip_exports_financial_once_uq");
    expect(routes).toContain("TRIP_PO_ALREADY_EXPORTED_DIFFERENT_CONTENT");
    expect(routes).toContain("confirmRatesReviewed");
    expect(routes).toContain("confirmChargesReviewed");
    expect(routes).toContain("FILE_GENERATED_NOT_ERP_IMPORTED");
    expect(guards).toContain("TRIP_EXPORTED_LOCKED");
    expect(routes).not.toContain("createPurchaseOrder");
    expect(routes).not.toContain("insertVoucher");
  });
});
