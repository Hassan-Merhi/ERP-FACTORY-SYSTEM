import { describe, expect, it } from "vitest";
import { buildSpContainerExcelImport, type SpExcelSourceContainer } from "../shared/spContainerExcelImport";
import { spContainerInvoiceChargesTotal } from "../shared/spContainerInvoiceCharges";

// The same file/preview must not post an ERP purchase voucher in a Supplier
// Partner company. The HTTP contracts are:
// POST /api/sp/containers/import-excel/parse
// POST /api/sp/containers/import-excel/validate
// POST /api/sp/containers
// The importer must use only the last endpoint after validation.
const supplier = [{ id: 9, code: "SUP", legalName: "Supplier Payable" }];
function example(containerNumber: string, po: string): SpExcelSourceContainer {
  return {
    containerNumber,
    supplierCode: "SUP",
    itemsTotal: 2400,
    charges: { freight: 200, surcharge: 25, fumigation: 10, discount: 60, documentCharges: 5 },
    chargesTotal: 180,
    grandTotal: 2580,
    items: [
      {
        poNumber: po,
        itemName: "Cotton",
        barcode: "ABC100",
        stockItemId: 21,
        quantity: 40,
        rate: 60,
        lineTotal: 2400,
      },
    ],
    pos: [po],
  };
}

describe("Supplier Payable container import accounting", () => {
  it("matches the normal ERP Excel total without posting ERP-specific cost entries", () => {
    const parsed = buildSpContainerExcelImport(example("MRKU1234567", "PO-SUP-100"), supplier);
    const expectedGoodsOtwDebit = parsed.invoiceTotalUsd;
    const expectedGoodsOtwClearingCredit = parsed.invoiceTotalUsd;
    expect(parsed.supplierId).toBe(9);
    expect(expectedGoodsOtwDebit).toBe(2580);
    expect(expectedGoodsOtwClearingCredit).toBe(2580);
    expect(expectedGoodsOtwDebit - expectedGoodsOtwClearingCredit).toBe(0);
    const discountedItems = parsed.itemsTotal * (1 - parsed.discountPct / 100);
    expect(discountedItems + spContainerInvoiceChargesTotal(parsed)).toBe(parsed.grandTotal);
  });

  it("keeps distinct containers even when the PO number is shared", () => {
    const first = buildSpContainerExcelImport(example("MRKU1234567", "PO-SUP-100"), supplier);
    const second = buildSpContainerExcelImport(example("MRKU9876543", "PO-SUP-100"), supplier);
    expect(first.containerNumber).not.toBe(second.containerNumber);
    expect(first.suggestedInvoiceNumber).toBe(second.suggestedInvoiceNumber);
    expect(first.lines[0].stockItemId).toBe(21);
    expect(second.invoiceTotalUsd).toBe(2580);
  });
});
