import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { styleSpecializedWorkbook } from "../shared/universal-excel/specializedWorkbookStyle";

function buildThreeSheetSpForm() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Original SP form";
  wb.calcProperties.fullCalcOnLoad = true;

  const costing = wb.addWorksheet("Costing", { state: "hidden" });
  costing.addRow(["Item Code", "Opening Qty", "Unit Cost"]);
  costing.addRow(["000001", 12, { formula: "15/3", result: 5 }]);
  const sales = wb.addWorksheet("Sales", { state: "hidden" });
  sales.addRow(["Item Code", "2026-11-13"]);
  sales.addRow(["000001", 2]);

  const entry = wb.addWorksheet("ENTRY");
  entry.addRow(["Date", "Item Code", "Total Qty"]);
  entry.addRow([]);
  entry.addRow(["Date", "Item Code", "Total Qty"]);
  entry.addRow(["2026-11-13", "000001", { formula: "Costing!B2-Sales!B2", result: 10 }]);
  entry.mergeCells("A1:C1");
  entry.views = [{ state: "frozen", xSplit: 2, ySplit: 3 }];
  entry.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: 3 } };
  entry.pageSetup.printTitlesRow = "1:3";
  entry.headerFooter.oddFooter = "&LSP Sheet&CPage &P";
  entry.dataValidations.add("B4", {
    type: "list", allowBlank: false, formulae: ['"000001,000002"'],
  });
  return wb;
}

describe("Phase 8 specialized workbook adapter", () => {
  it("preserves hidden SP support sheets, linked formulas, validations, names and freeze panes", async () => {
    const wb = buildThreeSheetSpForm();
    const originalFormula = wb.getWorksheet("ENTRY")!.getCell("C4").value;
    styleSpecializedWorkbook(wb, {
      expectedSheetNames: ["Costing", "Sales", "ENTRY"],
      sheets: [
        { name: "Costing", purpose: "formula-support" },
        { name: "Sales", purpose: "formula-support" },
        { name: "ENTRY", purpose: "report" },
      ],
    });
    expect(wb.creator).toBe("DAKZO SYSTEMS");
    expect(wb.worksheets.map(s => s.name)).toEqual(["Costing", "Sales", "ENTRY"]);
    expect(wb.getWorksheet("Costing")!.state).toBe("hidden");
    expect(wb.getWorksheet("Sales")!.state).toBe("hidden");
    expect(wb.calcProperties.fullCalcOnLoad).toBe(true);
    const ws = wb.getWorksheet("ENTRY")!;
    expect(ws.getCell("C4").value).toEqual(originalFormula);
    expect(ws.views).toEqual([{ state: "frozen", xSplit: 2, ySplit: 3 }]);
    expect(ws.autoFilter).toEqual({ from: { row: 3, column: 1 }, to: { row: 3, column: 3 } });
    expect(ws.pageSetup.printTitlesRow).toBe("1:3");
    expect(ws.headerFooter.oddFooter).toBe("&LSP Sheet&CPage &P");
    expect(ws.headerFooter.oddHeader).toContain("DAKZO SYSTEMS");
    expect(ws.dataValidations.model.B4).toMatchObject({ type: "list" });
    const parsed = new ExcelJS.Workbook();
    await parsed.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(parsed.getWorksheet("Costing")!.state).toBe("hidden");
    expect(parsed.getWorksheet("Sales")!.state).toBe("hidden");
    expect(parsed.getWorksheet("ENTRY")!.getCell("C4").value).toEqual(originalFormula);
    expect(parsed.getWorksheet("ENTRY")!.getCell("B4").value).toBe("000001");
    expect(parsed.getWorksheet("ENTRY")!.dataValidations.model.B4).toMatchObject({ type: "list" });
  });

  it("never moves or restyles a row-1 import sheet, including numeric and leading-zero codes", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Make Your Order");
    ws.addRow(["Ref Code", "Article Code", "Qty", "Price"]);
    ws.addRow(["00001234", "HMD123", 3, 8.5]);
    ws.getCell("A1").font = { bold: true, color: { argb: "FF334455" } };
    const original = JSON.stringify(ws.model);
    styleSpecializedWorkbook(wb, {
      expectedSheetNames: ["Make Your Order"],
      sheets: [{ name: "Make Your Order", purpose: "import-template" }],
    });
    expect(JSON.stringify(ws.model)).toBe(original);
    expect(ws.rowCount).toBe(2);
    expect(ws.getCell("A1").value).toBe("Ref Code");
    expect(ws.getCell("A2").value).toBe("00001234");
    expect(ws.getCell("C2").value).toBe(3);
    expect(ws.getCell("D2").value).toBe(8.5);
    expect(ws.headerFooter.oddHeader).toBeUndefined();
  });

  it("preserves exact drilldown links, cached numeric results, totals and title layout", () => {
    const wb = new ExcelJS.Workbook();
    const matrix = wb.addWorksheet("Monthly Production");
    matrix.getCell("A1").value = "MONTHLY PRODUCTION MATRIX";
    matrix.mergeCells("A1:E1");
    matrix.getRow(6).values = ["Product", "Code", "Category", "Nov 2026", "Total"];
    matrix.getCell("D7").value = {
      formula: 'HYPERLINK("#\'Worker Breakdown\'!A5",8)', result: 8,
    };
    matrix.getCell("E7").value = 8;
    matrix.getCell("D8").value = 8;
    matrix.getCell("E8").value = 8;
    matrix.views = [{ state: "frozen", xSplit: 3, ySplit: 6 }];
    const workers = wb.addWorksheet("Worker Breakdown");
    workers.getRow(3).values = ["Worker", "Bales", "Weight (kg)"];
    workers.getCell("B5").value = {
      formula: 'HYPERLINK("#\'Daily Summary\'!A4",8)', result: 8,
    };
    const daily = wb.addWorksheet("Daily Summary");
    daily.getRow(3).values = ["Date", "Product", "Quantity"];
    const refs = wb.addWorksheet("Bale References");
    refs.getRow(3).values = ["Reference number", "Code"];
    refs.getRow(4).values = ["000001234", "HMD100"];
    const before = matrix.getCell("D7").value;
    styleSpecializedWorkbook(wb, {
      expectedSheetNames: [
        "Monthly Production", "Worker Breakdown", "Daily Summary", "Bale References",
      ],
      sheets: wb.worksheets.map(sheet => ({ name: sheet.name, purpose: "report" as const })),
    });
    expect(matrix.getCell("D7").value).toEqual(before);
    expect(matrix.getCell("E7").value).toBe(8);
    expect(matrix.getCell("D8").value).toBe(8);
    expect(matrix.views).toEqual([{ state: "frozen", xSplit: 3, ySplit: 6 }]);
    expect(refs.getCell("A4").value).toBe("000001234");
    expect(matrix.model.merges).toContain("A1:E1");
  });

  it("does not duplicate headers, change data, or scan 30k+ rows in company data exports", () => {
    const wb = new ExcelJS.Workbook();
    const summary = wb.addWorksheet("SUMMARY");
    summary.addRow(["Full Data Export — Example"]);
    summary.addRow(["Generated at", "2026-11-14"]);
    summary.addRow([]);
    summary.addRow(["Data Category", "Record Count"]);
    summary.addRow(["Vouchers", 30_001]);
    const raw = wb.addWorksheet("Vouchers");
    raw.addRow(["voucher_number", "currency", "amount"]);
    for (let i = 1; i <= 30_001; i += 1) {
      raw.addRow(["V" + String(i).padStart(5, "0"), "USD", i]);
    }
    styleSpecializedWorkbook(wb, {
      sheets: [{ name: "SUMMARY", purpose: "report" }],
    });
    expect(raw.rowCount).toBe(30_002);
    expect(raw.getCell("A1").value).toBe("voucher_number");
    expect(raw.getCell("A30002").value).toBe("V30001");
    expect(raw.getCell("C30002").value).toBe(30_001);
    expect(raw.headerFooter.oddHeader).toBeUndefined();
    expect(summary.getCell("A4").value).toBe("Data Category");
    expect(summary.headerFooter.oddHeader).toContain("DAKZO SYSTEMS");
  });

  it("preserves merged container headings and invoice/proforma amounts", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("TCNU3846298");
    ws.addRow(["CONTAINER DETAILS"]);
    ws.addRow(["Container Number", "TCNU3846298"]);
    ws.addRow(["Grand Total", 5000.25]);
    ws.addRow([]);
    ws.addRow(["PURCHASE ORDER: PO001"]);
    ws.addRow(["Currency", "EUR"]);
    ws.addRow(["Amount", 4321.75]);
    ws.mergeCells("A1:B1");
    const before = [...ws.model.merges];
    styleSpecializedWorkbook(wb, {
      sheets: [{ name: "TCNU3846298", purpose: "report" }],
    });
    expect(ws.getCell("B3").value).toBe(5000.25);
    expect(ws.getCell("B7").value).toBe(4321.75);
    expect(ws.model.merges).toEqual(before);
    expect(ws.getCell("A5").value).toBe("PURCHASE ORDER: PO001");
    expect(ws.headerFooter.oddHeader).toContain("DAKZO SYSTEMS");
  });

  it("prevalidates missing/duplicate/unsafe sheet directives before mutating metadata", () => {
    const wb = buildThreeSheetSpForm();
    const creator = wb.creator;
    expect(() => styleSpecializedWorkbook(wb, {
      expectedSheetNames: ["ENTRY", "Costing", "Sales"],
    })).toThrow(/sheet order changed/);
    expect(() => styleSpecializedWorkbook(wb, {
      sheets: [{ name: "None" }],
    })).toThrow(/not found/);
    expect(() => styleSpecializedWorkbook(wb, {
      sheets: [{ name: "ENTRY" }, { name: "ENTRY" }],
    })).toThrow(/Duplicate/);
    expect(() => styleSpecializedWorkbook(wb, {
      sheets: [{ name: "ENTRY", purpose: "import-template", printBrand: true }],
    })).toThrow(/must not be restyled/);
    expect(() => styleSpecializedWorkbook(wb, {
      sheets: [{ name: "Costing", purpose: "formula-support", brandHeader: true, headerRow: 1 }],
    })).toThrow(/Invalid specialized report header/);
    expect(wb.creator).toBe(creator);
    expect(wb.getWorksheet("ENTRY")!.headerFooter.oddHeader).toBeUndefined();
  });

  it("brands only explicitly safe report headers, not hidden or protected formula cells", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Overview");
    ws.addRow(["Item Code", "Total"]);
    ws.addRow(["HMD100", 450.25]);
    styleSpecializedWorkbook(wb, {
      sheets: [{ name: "Overview", purpose: "report", headerRow: 1, brandHeader: true }],
    });
    expect(ws.getCell("A1").font.bold).toBe(true);
    expect(ws.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FF183153" } });
    expect(ws.getCell("B2").value).toBe(450.25);
  });
});
