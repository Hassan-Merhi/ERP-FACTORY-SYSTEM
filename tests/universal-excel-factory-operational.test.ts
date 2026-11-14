import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildUniversalExcelWorkbook } from "../shared/universal-excel/engine";
import { styleFactoryOperationalWorkbook } from "../shared/universal-excel/factoryOperationalStyle";

function legacyWorkbook() {
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet("Summary");
  summary.addRow(["Article", "Expected", "Verified", "Difference"]);
  summary.addRow(["000123", 10, 8, { formula: "B2-C2", result: 2 }]);
  summary.addRow(["TOTAL", 10, 8, 2]);
  summary.autoFilter = { from: "A1", to: "D2" };
  summary.views = [{ state: "frozen", ySplit: 1 }];
  summary.getCell("A2").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFEE2E2" },
  };
  const manifest = wb.addWorksheet("Manifest");
  manifest.mergeCells("A1:C2");
  manifest.getCell("A1").value = "TRUCK DISPATCH";
  manifest.addRow(["Bale", "KG", "Scanned at"]);
  manifest.addRow(["0000007", 36.125, "13/11/2026"]);
  return wb;
}

describe("Factory operational style bridge", () => {
  it("changes visual header style but preserves all data, formulas, filters, merges and sheet order", async () => {
    const wb = legacyWorkbook();
    const before = wb.getWorksheet("Summary")!;
    const formula = before.getCell("D2").value;
    const filter = JSON.stringify(before.autoFilter);
    const frozen = JSON.stringify(before.views);
    styleFactoryOperationalWorkbook(wb, [
      { name: "Summary", headerRow: 1 },
      { name: "Manifest", headerRow: 3, titleRow: 1 },
    ]);
    expect(wb.creator).toBe("DAKZO SYSTEMS");
    expect(wb.worksheets.map(s => s.name)).toEqual(["Summary", "Manifest"]);
    const ws = wb.getWorksheet("Summary")!;
    expect(ws.rowCount).toBe(3);
    expect(ws.getCell("A2").value).toBe("000123");
    expect(ws.getCell("D2").value).toEqual(formula);
    expect(JSON.stringify(ws.autoFilter)).toBe(filter);
    expect(JSON.stringify(ws.views)).toBe(frozen);
    expect(ws.getCell("A2").fill).toEqual({
      type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" },
    });
    expect(ws.getCell("A1").font.bold).toBe(true);
    expect(ws.getCell("A1").fill).toEqual({
      type: "pattern", pattern: "solid", fgColor: { argb: "FF183153" },
    });
    expect(wb.getWorksheet("Manifest")!.getCell("A1").value).toBe("TRUCK DISPATCH");
    expect(wb.getWorksheet("Manifest")!.model.merges).toContain("A1:C2");
    const raw = Buffer.from(await wb.xlsx.writeBuffer());
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(raw);
    expect(reopened.getWorksheet("Summary")!.getCell("A2").value).toBe("000123");
    expect(reopened.getWorksheet("Summary")!.getCell("D2").value).toEqual(formula);
    expect(reopened.getWorksheet("Manifest")!.getCell("B4").value).toBe(36.125);
  });

  it("preserves warning header fills on a Ground Scan layout when requested", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Missing Bales");
    ws.addRow(["Missing Bales"]);
    ws.addRow(["Produced but missing"]);
    ws.addRow([]);
    ws.addRow(["Reference", "Code"]);
    ws.getCell("A4").fill = {
      type: "pattern", pattern: "solid", fgColor: { argb: "FFB91C1C" },
    };
    styleFactoryOperationalWorkbook(wb, [
      { name: "Missing Bales", titleRow: 1, headerRow: 4, preserveHeaderFill: true },
    ]);
    expect(ws.getCell("A4").fill).toEqual({
      type: "pattern", pattern: "solid", fgColor: { argb: "FFB91C1C" },
    });
    expect(ws.getCell("A1").value).toBe("Missing Bales");
  });

  it("handles attendance sheets with exactly three pre-existing header rows", () => {
    const wb = new ExcelJS.Workbook();
    for (const name of ["Active Workers", "Inactive Workers"]) {
      const ws = wb.addWorksheet(name);
      ws.addRow(["Attendance Sheet"]);
      ws.addRow(["Monday to Saturday"]);
      ws.addRow(["#", "Worker Name", "Monday", "Notes"]);
      ws.addRow([1, "Worker A", "P", ""]);
      ws.mergeCells("A1:D1");
      ws.mergeCells("A2:D2");
    }
    styleFactoryOperationalWorkbook(wb, [
      { name: "Active Workers", titleRow: 1, headerRow: 3 },
      { name: "Inactive Workers", titleRow: 1, headerRow: 3 },
    ]);
    for (const name of ["Active Workers", "Inactive Workers"]) {
      const ws = wb.getWorksheet(name)!;
      expect(ws.rowCount).toBe(4);
      expect(ws.getCell("A3").value).toBe("#");
      expect(ws.getCell("B3").value).toBe("Worker Name");
      expect(ws.getCell("C4").value).toBe("P");
    }
  });

  it("rejects invalid sheet references without adding missing sheets", () => {
    const wb = legacyWorkbook();
    expect(() => styleFactoryOperationalWorkbook(wb, [{ name: "Unknown", headerRow: 1 }]))
      .toThrow(/sheet not found/);
    expect(() => styleFactoryOperationalWorkbook(wb, [{ name: "Summary", headerRow: 99 }]))
      .toThrow(/header position/);
    expect(wb.worksheets).toHaveLength(2);
  });
});

describe("Factory full report and import-safe workbook schemas", () => {
  it("keeps Factory bale cost hidden until authorized, and retains leading-zero references", () => {
    for (const canViewCost of [false, true]) {
      const columns = [
        { key: "reference", header: "Reference" },
        { key: "weight", header: "Weight", type: "decimal" as const },
        ...(canViewCost ? [{ key: "cost", header: "Cost", type: "money" as const }] : []),
      ];
      const rows = [{ reference: "000001", weight: 25.75, ...(canViewCost ? { cost: 19.95 } : {}) }];
      const wb = buildUniversalExcelWorkbook({
        schemaVersion: 1, mode: "report", title: "Bales",
        sheets: [{ kind: "table", name: "Bales", columns, rows }],
      }).workbook;
      const ws = wb.getWorksheet("Bales")!;
      expect(ws.getCell("A6").value).toBe("000001");
      expect(ws.getCell("B6").value).toBe(25.75);
      expect(ws.getCell("C6").value).toBe(canViewCost ? 19.95 : null);
    }
  });

  it("keeps re-importable price lists at row 1 and numeric prices unchanged", () => {
    const wb = buildUniversalExcelWorkbook({
      schemaVersion: 1, mode: "import-template", title: "Factory Price List",
      sheets: [{
        kind: "table", name: "Price List",
        columns: [
          { key: "id", header: "ID (do not edit)", type: "integer" },
          { key: "code", header: "Article Code" },
          { key: "price", header: "Selling Price ($/bale)", type: "money" },
        ],
        rows: [{ id: 12, code: "000045", price: 18.25 }],
      }],
    }).workbook;
    const ws = wb.getWorksheet("Price List")!;
    expect(ws.getCell("A1").value).toBe("ID (do not edit)");
    expect(ws.getCell("A2").value).toBe(12);
    expect(ws.getCell("B2").value).toBe("000045");
    expect(ws.getCell("C2").value).toBe(18.25);
  });
});
