import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { extractFinalizedReturnReferences } from "../client/src/pages/factory/finalizedSaleReturnImportFile";

describe("finalized return Excel reference column extraction", () => {
  it("uses Ref Code column rather than the article code or quantities", () => {
    const sheet = new ExcelJS.Workbook().addWorksheet("Returns");
    sheet.addRow(["Article Code", "Ref Code", "Qty"]);
    sheet.addRow(["T-SHIRT", "HMD001", 1]);
    sheet.addRow(["T-SHIRT", "HMD002", 1]);
    expect(extractFinalizedReturnReferences(sheet)).toEqual(["HMD001", "HMD002"]);
  });

  it("reads a one-column headerless file and preserves duplicates for server validation", () => {
    const sheet = new ExcelJS.Workbook().addWorksheet("Returns");
    sheet.addRow(["HMD003"]);
    sheet.addRow(["HMD003"]);
    expect(extractFinalizedReturnReferences(sheet)).toEqual(["HMD003", "HMD003"]);
  });

  it("refuses arbitrary multi-column files without a reference header", () => {
    const sheet = new ExcelJS.Workbook().addWorksheet("Returns");
    sheet.addRow(["Article Code", "Qty"]);
    sheet.addRow(["SKU", 5]);
    expect(() => extractFinalizedReturnReferences(sheet)).toThrow("Ref Code");
  });

  it("rejects files with more than 1,000 reference rows", () => {
    const sheet = new ExcelJS.Workbook().addWorksheet("Returns");
    sheet.addRow(["Ref Code"]);
    for (let n = 0; n < 1001; n += 1) sheet.addRow(["HMD" + n]);
    expect(() => extractFinalizedReturnReferences(sheet)).toThrow("1,000");
  });
});
