import { describe, expect, it } from "vitest";

import {
  SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH,
  buildSpContainerExcelImport,
  matchSupplierByCode,
  type SpExcelSourceContainer,
} from "./spContainerExcelImport";
import {
  SP_CONTAINER_INVOICE_CHARGE_TYPE,
  spContainerInvoiceChargeLines,
  spContainerInvoiceChargesTotal,
} from "./spContainerInvoiceCharges";

const suppliers = [
  { id: 7, legalName: "Golden Coast Trading", code: "GC" },
  { id: 9, legalName: "Other Supplier", code: "OTH" },
];

function sourceContainer(overrides: Partial<SpExcelSourceContainer> = {}): SpExcelSourceContainer {
  return {
    containerNumber: "MSKU1234567",
    supplierCode: "gc",
    itemsTotal: 10_000,
    charges: { freight: 1_200, surcharge: 300, fumigation: 50, discount: 500, documentCharges: 150 },
    chargesTotal: 1_200 + 300 + 50 + 150 - 500,
    grandTotal: 10_000 + 1_200 + 300 + 50 + 150 - 500,
    items: [
      {
        poNumber: "PO-2026-001",
        barcode: "A001",
        stockItemId: 101,
        itemName: "Used Clothing Mix",
        quantity: 500,
        rate: 12,
        lineTotal: 6_000,
      },
      {
        poNumber: "PO-2026-001",
        barcode: "A002",
        stockItemId: null,
        itemName: "Shoes",
        quantity: 200,
        rate: 20,
        lineTotal: 4_000,
      },
    ],
    pos: ["PO-2026-001"],
    ...overrides,
  };
}

// Served by POST /api/sp/containers/import-excel/parse (server/routes/sp/spContainerRoutes.ts).
describe(`Supplier Partner Excel import calculation (${SP_CONTAINER_EXCEL_IMPORT_PARSE_PATH})`, () => {
  it("posts Goods OTW for the same grand total the ERP would post for the file", () => {
    const result = buildSpContainerExcelImport(sourceContainer(), suppliers);

    expect(result.itemsTotal).toBe(10_000);
    expect(result.chargesTotal).toBe(1_200);
    expect(result.grandTotal).toBe(11_200);
    expect(result.invoiceTotalUsd).toBe(11_200);
    expect(result.freightEstimateUsd).toBe(1_200);
    expect(result.surchargeUsd).toBe(300);
    expect(result.fumigationUsd).toBe(50);
    expect(result.documentChargesUsd).toBe(150);
  });

  it("carries every invoice charge into landed cost at offload, so base + charges = Goods OTW", () => {
    const result = buildSpContainerExcelImport(sourceContainer(), suppliers);
    const offloadLines = spContainerInvoiceChargeLines(result);

    expect(offloadLines.map((line) => [line.kind, line.amountUsd])).toEqual([
      ["freight", 1_200],
      ["surcharge", 300],
      ["fumigation", 50],
      ["document_charges", 150],
    ]);
    expect(offloadLines.every((line) => line.chargeType === SP_CONTAINER_INVOICE_CHARGE_TYPE)).toBe(true);
    const base = result.itemsTotal - result.charges.discount;
    expect(base + spContainerInvoiceChargesTotal(result)).toBe(result.invoiceTotalUsd);
    expect(spContainerInvoiceChargeLines({ freightEstimateUsd: "0", surchargeUsd: null })).toEqual([]);
  });

  it("turns the sheet's discount amount into the SP uniform discount percentage", () => {
    const result = buildSpContainerExcelImport(sourceContainer(), suppliers);

    // 500 of 10,000 = 5%; the SP base cost Σ qty × rate × (1 − 5%) equals items − discount.
    expect(result.discountPct).toBe(5);
    const discountedBase = result.lines.reduce(
      (sum, line) => sum + line.qty * line.unitRateUsd * (1 - result.discountPct / 100),
      0
    );
    expect(discountedBase).toBeCloseTo(9_500, 6);
  });

  it("keeps the discount percentage within the column's 4-decimal scale", () => {
    const result = buildSpContainerExcelImport(
      sourceContainer({
        itemsTotal: 9_873.33,
        charges: { freight: 0, surcharge: 0, fumigation: 0, discount: 123.45, documentCharges: 0 },
      }),
      suppliers
    );

    expect(result.discountPct).toBe(1.2503);
    expect(String(result.discountPct).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });

  it("matches the supplier by code regardless of case and fills the article lines", () => {
    const result = buildSpContainerExcelImport(sourceContainer(), suppliers);

    expect(result.supplierId).toBe(7);
    expect(result.supplierName).toBe("Golden Coast Trading");
    expect(result.poNumbers).toEqual(["PO-2026-001"]);
    expect(result.suggestedInvoiceNumber).toBe("PO-2026-001");
    expect(result.lines).toEqual([
      {
        articleCode: "A001",
        description: "Used Clothing Mix",
        qty: 500,
        unitRateUsd: 12,
        lineTotal: 6_000,
        stockItemId: 101,
        poNumber: "PO-2026-001",
      },
      {
        articleCode: "A002",
        description: "Shoes",
        qty: 200,
        unitRateUsd: 20,
        lineTotal: 4_000,
        stockItemId: null,
        poNumber: "PO-2026-001",
      },
    ]);
    expect(result.unmatchedArticleCodes).toEqual(["A002"]);
  });

  it("records the source, the PO numbers and the discount conversion on the notes", () => {
    const result = buildSpContainerExcelImport(sourceContainer(), suppliers);

    expect(result.notes).toContain("Imported from PO Import Excel");
    expect(result.notes).toContain("Discount $500.00 (5% of items)");
    expect(result.notes).toContain("PO PO-2026-001");
  });

  it("falls back to the item name as article code and to the container number as invoice number", () => {
    const result = buildSpContainerExcelImport(
      sourceContainer({
        items: [
          {
            poNumber: "",
            barcode: null,
            stockItemId: null,
            itemName: "Unlabelled bale",
            quantity: 3,
            rate: 10,
            lineTotal: 30,
          },
        ],
        pos: [""],
        itemsTotal: 30,
        charges: { freight: 0, surcharge: 0, fumigation: 0, discount: 0, documentCharges: 0 },
        chargesTotal: 0,
        grandTotal: 30,
        supplierCode: "UNKNOWN",
      }),
      suppliers
    );

    expect(result.lines[0].articleCode).toBe("Unlabelled bale");
    expect(result.poNumbers).toEqual([]);
    expect(result.suggestedInvoiceNumber).toBe("MSKU1234567");
    expect(result.supplierId).toBeNull();
    expect(result.supplierName).toBe("");
    expect(result.discountPct).toBe(0);
  });

  it("matchSupplierByCode ignores blanks", () => {
    expect(matchSupplierByCode("", suppliers)).toBeNull();
    expect(matchSupplierByCode("  oth ", suppliers)?.id).toBe(9);
  });
});
