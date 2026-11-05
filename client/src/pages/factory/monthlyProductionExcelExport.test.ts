import { describe, expect, it } from "vitest";
import { buildMonthlyProductionExcelWorkbook, productionMonthTone } from "./monthlyProductionExcelExport";
import type { MonthlyProductionExportBale } from "./monthlyProductionWorkbookDrilldown";

const months = ["2026-09", "2026-10", "2026-11"];
const monthLabels = ["Sep 2026", "Oct 2026", "Nov 2026"];
const rows = [
  { productId: 1533, name: "Test bale product", articleCode: "HMD100", categoryName: "SUMMER", values: [5, 2, 8] },
  { productId: 2099, name: "Even production", articleCode: "HMD200", categoryName: "WINTER", values: [3, 3, 3] },
];

const bales: MonthlyProductionExportBale[] = rows.flatMap((product) =>
  product.values.flatMap((count, monthIndex) => Array.from({ length: count }, (_, index) => {
    const month = months[monthIndex];
    const workerId = index % 2 === 0 ? 42 : 43;
    const baleId = product.productId * 1000 + monthIndex * 100 + index;
    return {
      baleId, productId: product.productId, month,
      workerId, workerName: workerId === 42 ? "Worker One" : "Worker Two",
      referenceNumber: "REF" + baleId, baleCode: product.articleCode,
      date: month + (index % 2 === 0 ? "-02" : "-03"),
      productName: product.name, weightKg: "40", status: "IN_STOCK",
      category: product.categoryName, grade: "A", locationName: "Main Warehouse",
    };
  }))
);

const input = { months, monthLabels, rows, bales, category: "", search: "" };

describe("monthly production Excel drill-down", () => {
  it("matches the on-screen per-item highest and lowest month colors", () => {
    expect(rows[0].values.map((_, index) => productionMonthTone(rows[0].values, index)))
      .toEqual(["normal", "lowest", "highest"]);
    expect(rows[1].values.map((_, index) => productionMonthTone(rows[1].values, index)))
      .toEqual(["normal", "normal", "normal"]);
  });

  it("preserves the formatted landscape matrix and correct row/grand totals", () => {
    const book = buildMonthlyProductionExcelWorkbook(input);
    const sheet = book.getWorksheet("Monthly Production");
    if (!sheet) throw new Error("Missing Monthly Production");
    expect(sheet.getTable("FactoryMonthlyProduction")).toBeDefined();
    expect(sheet.pageSetup.orientation).toBe("landscape");
    expect(sheet.pageSetup.fitToWidth).toBe(1);
    expect(sheet.pageSetup.printTitlesRow).toBe("1:6");
    expect(sheet.getCell("E7").fill).toMatchObject({ fgColor: { argb: "FFFEE2E2" } });
    expect(sheet.getCell("F7").fill).toMatchObject({ fgColor: { argb: "FFD1FAE5" } });
    expect(sheet.getCell("G7").value).toMatchObject({ result: 15 });
    expect(sheet.getCell("G9").value).toMatchObject({ result: 24 });
  });

  it("navigates entirely within four embedded worksheets, with one detailed row per bale", () => {
    const book = buildMonthlyProductionExcelWorkbook(input);
    expect(book.worksheets.map((sheet) => sheet.name)).toEqual([
      "Monthly Production", "Worker Breakdown", "Daily Summary", "Bale References",
    ]);
    const matrix = book.getWorksheet("Monthly Production");
    const workers = book.getWorksheet("Worker Breakdown");
    const daily = book.getWorksheet("Daily Summary");
    const references = book.getWorksheet("Bale References");
    if (!matrix || !workers || !daily || !references) throw new Error("Missing worksheet");

    expect(matrix.getCell("D7").value).toMatchObject({
      formula: expect.stringContaining('HYPERLINK("#\'Worker Breakdown\'!A'),
      result: 5,
    });
    expect(matrix.getCell("G7").value).toMatchObject({
      formula: expect.stringContaining('HYPERLINK("#\'Worker Breakdown\'!A'),
      result: 15,
    });

    const workerLinks: string[] = [];
    workers.eachRow((row) => {
      const value = row.getCell(2).value;
      if (value && typeof value === "object" && "formula" in value) workerLinks.push(value.formula);
    });
    expect(workerLinks.some((formula) => formula.includes("#'Daily Summary'!A"))).toBe(true);

    const dailyLinks: string[] = [];
    daily.eachRow((row) => {
      const value = row.getCell(3).value;
      if (value && typeof value === "object" && "formula" in value) dailyLinks.push(value.formula);
    });
    expect(dailyLinks.some((formula) => formula.includes("#'Bale References'!A"))).toBe(true);
    expect(references.rowCount).toBe(3 + bales.length);
    expect(references.getCell("E4").value).toMatch(/^REF/);
    expect(references.getCell("H4").value).toBe(40);
    expect(references.getCell("G4").value).toBe(1);
  });

  it("keeps zeros unlinked and rejects incomplete bale detail snapshots", () => {
    const zeroRows = [{ ...rows[0], values: [0, 2, 8] }];
    const zeroBales = bales.filter((bale) =>
      bale.productId === 1533 && bale.month !== "2026-09");
    const book = buildMonthlyProductionExcelWorkbook({
      ...input, rows: zeroRows, bales: zeroBales,
    });
    expect(book.getWorksheet("Monthly Production")?.getCell("D7").value).toBe(0);
    expect(() => buildMonthlyProductionExcelWorkbook({ ...input, bales: bales.slice(1) }))
      .toThrow("Production counts changed");
    expect(() => buildMonthlyProductionExcelWorkbook({ ...input, bales: [...bales, bales[0]] }))
      .toThrow("Duplicate bale");
  });

  it("rejects month label and column length mismatches", () => {
    expect(() => buildMonthlyProductionExcelWorkbook({ ...input, monthLabels: ["Sep 2026"] }))
      .toThrow("Select at least one valid month");
    expect(() => buildMonthlyProductionExcelWorkbook({
      ...input, rows: [{ ...rows[0], values: [5, 2] }],
    })).toThrow("mismatched month");
  });
});
