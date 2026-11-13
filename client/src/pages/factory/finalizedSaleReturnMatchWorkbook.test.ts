import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildFinalizedReturnMatchWorkbook } from "./finalizedSaleReturnMatchWorkbook";

describe("finalized customer return pre-apply Excel report", () => {
  it("exports exact bale references and grouped quantities without posting financial data", () => {
    const workbook = new ExcelJS.Workbook();
    buildFinalizedReturnMatchWorkbook(workbook, {
      customerName: "Acme Customer",
      uploadedFile: "returned.xlsx",
      rows: [
        { reference: "000012", status: "matched", message: null, invoiceNumber: "INV-101", containerNumber: "CONT-9", articleCode: "000045", productName: "Cotton Bale" },
        { reference: "000013", status: "matched", message: null, invoiceNumber: "INV-101", containerNumber: "CONT-9", articleCode: "000045", productName: "Cotton Bale" },
        { reference: "DOES-NOT-EXIST", status: "missing", message: "Not found for customer" },
        { reference: "000013", status: "duplicate", message: "Duplicate in file" },
      ],
    });

    const matched = workbook.getWorksheet("Matched Bales")!;
    const issues = workbook.getWorksheet("Unmatched - Review")!;
    const summary = workbook.getWorksheet("Quantity Summary")!;
    expect(matched.rowCount).toBe(3);
    expect(matched.getRow(1).getCell(1).value).toBe("Ref Number");
    expect(matched.getRow(2).getCell(1).value).toBe("000012");
    expect(matched.getRow(2).getCell(2).value).toBe("000045");
    expect(matched.getRow(2).getCell(3).value).toBe("Cotton Bale");
    expect(matched.getRow(2).getCell(4).value).toBe(1);
    expect(matched.getRow(3).getCell(4).value).toBe(1);
    expect(issues.rowCount).toBe(3);
    expect(issues.getRow(2).getCell(4).value).toBe(0);
    expect(summary.getRow(3).getCell(2).value).toBe(2);
    expect(summary.getRow(4).getCell(2).value).toBe(2);
    expect(summary.getRow(8).getCell(1).value).toBe("000045");
    expect(summary.getRow(8).getCell(4).value).toBe(2);
    expect(summary.getRow(9).getCell(4).value).toBe(2);
  });

  it("keeps spreadsheet formula-like input as literal text", () => {
    const workbook = new ExcelJS.Workbook();
    buildFinalizedReturnMatchWorkbook(workbook, {
      customerName: "=SUM(1,1)",
      uploadedFile: "import.xlsx",
      rows: [{ reference: "=1+1", status: "matched", message: null, articleCode: "+123", productName: "@Bale" }],
    });
    const sheet = workbook.getWorksheet("Matched Bales")!;
    expect(sheet.getRow(2).getCell(1).value).toBe("'=1+1");
    expect(sheet.getRow(2).getCell(2).value).toBe("'+123");
    expect(sheet.getRow(2).getCell(3).value).toBe("'@Bale");
    expect(sheet.getRow(2).getCell(8).value).toBe("'=SUM(1,1)");
  });
});
