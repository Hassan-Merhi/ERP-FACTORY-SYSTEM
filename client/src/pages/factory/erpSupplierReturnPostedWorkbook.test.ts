import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildPostedSupplierReturnWorkbook, type PostedSupplierReturnRow } from "./erpSupplierReturnPostedWorkbook";

const receipt = {
  id: 43,
  returnDate: "2026-11-14",
  fileName: "returns.xlsx",
  reason: "Damaged",
  totalQty: "18.000",
  supplierCreditUsd: "1050.07",
  inventoryReductionUsd: "1170.00",
};
const line = (
  id: number,
  quantity: string,
  credit: string,
  inventory: string,
  extras: Partial<PostedSupplierReturnRow> = {}
): PostedSupplierReturnRow => ({
  id,
  articleCode: "HMD12034",
  itemName: "Mixed Bale",
  quantity,
  containerNumber: `CONTAINER-${id}`,
  offloadId: 100 + id,
  offloadItemId: id,
  supplier: "Supplier A",
  supplierCreditUsd: credit,
  inventoryReductionUsd: inventory,
  sourcePurchaseRate: id === 1 ? "58.1200000" : "62.0300000",
  voucherNumber: `SUP-RETURN-${id}`,
  voucherId: 500 + id,
  ...extras,
});

describe("posted ERP supplier returns Excel", () => {
  it("exports 17+1 separate source and input allocation lines with exact batch totals", () => {
    const wb = new ExcelJS.Workbook();
    buildPostedSupplierReturnWorkbook(wb, receipt, [
      line(1, "17.000", "988.04", "1105.00", {
        requestedRows: [
          {
            inputRow: 2,
            requestedArticleCode: "HMD12034",
            requestedQuantity: "18.000",
            allocatedQuantity: "17.000",
          },
        ],
      }),
      line(2, "1.000", "62.03", "65.00", {
        requestedRows: [
          {
            inputRow: 2,
            requestedArticleCode: "HMD12034",
            requestedQuantity: "18.000",
            allocatedQuantity: "1.000",
          },
        ],
      }),
    ]);
    const posted = wb.getWorksheet("Posted Source Lines")!;
    expect(posted.getRow(2).getCell(8).value).toBe(17);
    expect(posted.getRow(3).getCell(8).value).toBe(1);
    expect(posted.getRow(4).getCell(8).value).toBe(18);
    expect(posted.getRow(4).getCell(11).value).toBe(1050.07);
    expect(posted.getRow(4).getCell(12).value).toBe(1170);
    const requested = wb.getWorksheet("Original Input Allocations")!;
    expect(requested.getRow(2).getCell(6).value).toBe(17);
    expect(requested.getRow(3).getCell(6).value).toBe(1);
    // Summary rows: batch, return date, file, reason, source lines, removed quantity.
    expect(wb.getWorksheet("Posted Summary")!.getRow(4).getCell(2).value).toBe("returns.xlsx");
    expect(wb.getWorksheet("Posted Summary")!.getRow(7).getCell(2).value).toBe(18);
  });

  it("does not duplicate financial amounts for two input rows sharing a source", () => {
    const wb = new ExcelJS.Workbook();
    buildPostedSupplierReturnWorkbook(
      wb,
      {
        ...receipt,
        totalQty: "3.000",
        supplierCreditUsd: "30.00",
        inventoryReductionUsd: "36.00",
      },
      [
        line(3, "3.000", "30.00", "36.00", {
          requestedRows: [
            { inputRow: 2, requestedArticleCode: "A", requestedQuantity: "1.000", allocatedQuantity: "1.000" },
            { inputRow: 3, requestedArticleCode: "A", requestedQuantity: "2.000", allocatedQuantity: "2.000" },
          ],
        }),
      ]
    );
    expect(wb.getWorksheet("Posted Source Lines")!.getRow(3).getCell(11).value).toBe(30);
    expect(wb.getWorksheet("Original Input Allocations")!.rowCount).toBe(3);
  });

  it("supports legacy batches whose request row mapping was never recorded", () => {
    const wb = new ExcelJS.Workbook();
    buildPostedSupplierReturnWorkbook(
      wb,
      {
        ...receipt,
        totalQty: "1.000",
        supplierCreditUsd: "10.00",
        inventoryReductionUsd: "12.00",
      },
      [
        line(5, "1.000", "10.00", "12.00", {
          sourcePurchaseRate: null,
          requestedRows: [],
        }),
      ]
    );
    expect(wb.getWorksheet("Original Input Allocations")!.getRow(2).getCell(2).value).toMatch(/Legacy return/);
    expect(wb.getWorksheet("Posted Source Lines")!.getRow(2).getCell(9).value).toBe("");
  });

  it("refuses an export when source-level financials disagree with posted batch totals", () => {
    const wb = new ExcelJS.Workbook();
    expect(() => buildPostedSupplierReturnWorkbook(wb, receipt, [line(1, "17.000", "988.04", "1105.00")])).toThrow(
      /do not reconcile/
    );
  });

  it("rejects inconsistent repeated request-row amounts", () => {
    const wb = new ExcelJS.Workbook();
    const a = line(1, "17.000", "988.04", "1105.00", {
      requestedRows: [
        {
          inputRow: 2,
          requestedArticleCode: "A",
          requestedQuantity: "18",
          allocatedQuantity: "17",
        },
      ],
    });
    const b = line(2, "1.000", "62.03", "65.00", {
      requestedRows: [
        {
          inputRow: 2,
          requestedArticleCode: "A",
          requestedQuantity: "19",
          allocatedQuantity: "1",
        },
      ],
    });
    expect(() => buildPostedSupplierReturnWorkbook(wb, receipt, [a, b])).toThrow(/do not agree/);
  });

  it("escapes spreadsheet formulas in container, supplier, article and reason", () => {
    const wb = new ExcelJS.Workbook();
    buildPostedSupplierReturnWorkbook(
      wb,
      {
        ...receipt,
        reason: "=BAD()",
        totalQty: "1",
        supplierCreditUsd: "10",
        inventoryReductionUsd: "12",
      },
      [
        line(1, "1", "10", "12", {
          containerNumber: "-DANGEROUS",
          supplier: "=BAD()",
          articleCode: "+CODE",
          requestedRows: [],
        }),
      ]
    );
    const posted = wb.getWorksheet("Posted Source Lines")!;
    expect(posted.getRow(2).getCell(2).value).toBe("'+CODE");
    expect(posted.getRow(2).getCell(6).value).toBe("'-DANGEROUS");
    expect(posted.getRow(2).getCell(7).value).toBe("'=BAD()");
    expect(wb.getWorksheet("Posted Summary")!.getRow(5).getCell(2).value).toBe("'=BAD()");
  });
});
