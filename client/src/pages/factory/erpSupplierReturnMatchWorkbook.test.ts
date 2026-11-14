import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildErpSupplierReturnMatchWorkbook } from "./erpSupplierReturnMatchWorkbook";

describe("ERP supplier return pre-application Excel review", () => {
  it("exports source offload refs, article details, exact matching quantities and supplier totals", () => {
    const wb = new ExcelJS.Workbook();
    const candidate = {
      offloadItemId: 17,
      offloadId: 93,
      containerNumber: "CONT-2026-A",
      supplierName: "Supplier A",
      code: "000047",
      name: "Blue Bale",
      originalQty: "12",
      returnedQty: "2",
      remainingQty: "10",
      availableQty: "8",
      unitPurchaseCost: "4.50",
      unitLandedCost: "5.25",
    };
    buildErpSupplierReturnMatchWorkbook(wb, {
      supplierName: "Supplier A",
      fileName: "ERP_upload.xlsx",
      entries: [
        { row: 2, code: "000047", quantity: "2", status: "matched", candidate, valid: true },
        { row: 3, code: "000047", quantity: "1", status: "matched", candidate, valid: true },
        { row: 4, code: "NOTFOUND", quantity: "3", status: "not-found", valid: false },
      ],
    });
    const sheet = wb.getWorksheet("Matched Containers")!;
    expect(sheet.getRow(1).getCell(1).value).toBe("Ref Number");
    expect(sheet.getRow(2).getCell(1).value).toBe("OFFLOAD-93");
    expect(sheet.getRow(2).getCell(2).value).toBe("000047");
    expect(sheet.getRow(2).getCell(3).value).toBe("Blue Bale");
    expect(sheet.getRow(2).getCell(4).value).toBe(2);
    expect(sheet.getRow(2).getCell(14).value).toBe(9);
    expect(wb.getWorksheet("Unmatched - Review")!.getRow(2).getCell(15).value).toBe("not-found");
    const summary = wb.getWorksheet("Quantity Summary")!;
    expect(summary.getRow(9).getCell(4).value).toBe(3);
    expect(summary.getRow(9).getCell(5).value).toBe(13.5);
    expect(summary.getRow(10).getCell(4).value).toBe(3);
  });

  it("renders user-owned codes and names as formula-safe plain strings", () => {
    const wb = new ExcelJS.Workbook();
    buildErpSupplierReturnMatchWorkbook(wb, {
      supplierName: "=HYPERLINK(1)",
      entries: [
        {
          row: 2,
          code: "=1+1",
          quantity: "1",
          status: "matched",
          valid: true,
          candidate: {
            offloadItemId: 19,
            offloadId: 55,
            containerNumber: "-C2",
            supplierName: "=BAD()",
            code: "+INJ",
            name: "@NAME",
            originalQty: "1",
            returnedQty: "0",
            remainingQty: "1",
            availableQty: "1",
            unitPurchaseCost: "1",
            unitLandedCost: "1",
          },
        },
      ],
    });
    const sheet = wb.getWorksheet("Matched Containers")!;
    expect(sheet.getRow(2).getCell(2).value).toBe("'+INJ");
    expect(sheet.getRow(2).getCell(3).value).toBe("'@NAME");
    expect(sheet.getRow(2).getCell(5).value).toBe("'-C2");
    expect(sheet.getRow(2).getCell(6).value).toBe("'=BAD()");
    expect(wb.getWorksheet("Quantity Summary")!.getRow(1).getCell(2).value).toBe("'=HYPERLINK(1)");
  });
  it("exports 17 + 1 source splits against one requested quantity without double counting", () => {
    const wb = new ExcelJS.Workbook();
    const base = {
      offloadId: 91,
      offloadItemId: 10,
      containerNumber: "A",
      supplierName: "Supplier A",
      code: "HMD12034",
      name: "Mix",
      originalQty: "17",
      returnedQty: "0",
      remainingQty: "17",
      availableQty: "18",
      unitPurchaseCost: "58",
      unitLandedCost: "60",
      averageCost: "65",
    };
    buildErpSupplierReturnMatchWorkbook(wb, {
      entries: [
        {
          row: 2,
          code: "HMD12034",
          requestedQuantity: "18",
          quantity: "17",
          status: "matched",
          valid: true,
          candidate: base,
        },
        {
          row: 2,
          code: "HMD12034",
          requestedQuantity: "18",
          quantity: "1",
          status: "matched",
          valid: true,
          candidate: {
            ...base,
            offloadId: 92,
            offloadItemId: 11,
            containerNumber: "B",
            originalQty: "5",
            remainingQty: "5",
            unitPurchaseCost: "62",
          },
        },
      ],
    });
    const matched = wb.getWorksheet("Matched Containers")!;
    expect(matched.getRow(2).getCell(17).value).toBe(18);
    expect(matched.getRow(2).getCell(18).value).toBe(17);
    expect(matched.getRow(3).getCell(18).value).toBe(1);
    expect(matched.getRow(2).getCell(21).value).toBe(1105);
    const original = wb.getWorksheet("Input Row Allocations")!;
    expect(original.getRow(2).getCell(3).value).toBe(18);
    expect(original.getRow(2).getCell(4).value).toBe(18);
    expect(original.getRow(2).getCell(5).value).toBe(0);
    expect(wb.getWorksheet("Quantity Summary")!.getRow(11).getCell(4).value).toBe(18);
  });

  it("keeps incomplete source allocation visible in the input row review", () => {
    const wb = new ExcelJS.Workbook();
    buildErpSupplierReturnMatchWorkbook(wb, {
      entries: [{ row: 2, code: "A", requestedQuantity: "18", quantity: "17", status: "partial", valid: false }],
    });
    const review = wb.getWorksheet("Input Row Allocations")!;
    expect(review.getRow(2).getCell(3).value).toBe(18);
    expect(review.getRow(2).getCell(4).value).toBe(0);
    expect(review.getRow(2).getCell(5).value).toBe(18);
    expect(review.getRow(2).getCell(6).value).toBe("review");
  });
});
