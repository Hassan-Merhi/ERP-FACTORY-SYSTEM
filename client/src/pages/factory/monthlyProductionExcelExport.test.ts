import { describe, expect, it } from "vitest";
import { buildMonthlyProductionExcelWorkbook, monthlyProductionDrilldownUrl, productionMonthTone } from "./monthlyProductionExcelExport";

const input = {
  months: ["2026-09", "2026-10", "2026-11"],
  monthLabels: ["Sep 2026", "Oct 2026", "Nov 2026"],
  category: "",
  search: "",
  appOrigin: "https://www.hmdinternationalgroup.com",
  rows: [
    { productId: 1533, name: "Test bale product", articleCode: "HMD100", categoryName: "SUMMER", values: [5, 2, 8] },
    { productId: 2099, name: "Even production", articleCode: "HMD200", categoryName: "WINTER", values: [3, 3, 3] },
  ],
};

describe("monthly production Excel export", () => {
  it("matches the screen's per-item highest and lowest rules", () => {
    expect(input.rows[0].values.map((_, i) => productionMonthTone(input.rows[0].values, i)))
      .toEqual(["normal", "lowest", "highest"]);
    expect(input.rows[1].values.map((_, i) => productionMonthTone(input.rows[1].values, i)))
      .toEqual(["normal", "normal", "normal"]);
    expect(productionMonthTone([11], 0)).toBe("normal");
  });

  it("exports a real Excel table with landscape printing and correct totals", () => {
    const workbook = buildMonthlyProductionExcelWorkbook(input);
    const worksheet = workbook.getWorksheet("Monthly Production");
    expect(worksheet).toBeDefined();
    if (!worksheet) throw new Error("Worksheet was not created");

    expect(worksheet.getTable("FactoryMonthlyProduction")).toBeDefined();
    expect(worksheet.pageSetup.orientation).toBe("landscape");
    expect(worksheet.pageSetup.fitToWidth).toBe(1);
    expect(worksheet.pageSetup.fitToHeight).toBe(0);
    expect(worksheet.pageSetup.printTitlesRow).toBe("1:6");
    expect(worksheet.getCell("A7").value).toBe("Test bale product");
    expect(worksheet.getCell("E7").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FFFEE2E2" },
    });
    expect(worksheet.getCell("F7").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FFD1FAE5" },
    });
    expect(worksheet.getCell("G7").value).toMatchObject({ result: 15 });
    expect(worksheet.getCell("G9").value).toMatchObject({ result: 24 });
  });

  it("opens the exact ERP worker page for a month and for the row's selected-month total", () => {
    const workbook = buildMonthlyProductionExcelWorkbook(input);
    const sheet = workbook.getWorksheet("Monthly Production");
    if (!sheet) throw new Error("Worksheet was not created");
    expect(sheet.getCell("D7").value).toMatchObject({
      result: 5,
      formula: 'HYPERLINK("https://www.hmdinternationalgroup.com/factory/monthly-production-matrix/1533/workers?months=2026-09",5)',
    });
    expect(sheet.getCell("E7").value).toMatchObject({ result: 2 });
    expect(sheet.getCell("F7").value).toMatchObject({ result: 8 });
    expect(sheet.getCell("G7").value).toMatchObject({
      result: 15,
      formula: 'HYPERLINK("https://www.hmdinternationalgroup.com/factory/monthly-production-matrix/1533/workers?months=2026-09%2C2026-10%2C2026-11",15)',
    });
    expect(sheet.getCell("E7").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FFFEE2E2" },
    });
    expect(sheet.getCell("G7").font.underline).toBe(true);
    expect(sheet.getCell("G9").value).toMatchObject({ result: 24 });
  });

  it("keeps zero counts numeric and unlinked and validates the target location", () => {
    const workbook = buildMonthlyProductionExcelWorkbook({
      ...input,
      rows: [{ ...input.rows[0], values: [0, 2, 8] }],
    });
    const sheet = workbook.getWorksheet("Monthly Production");
    if (!sheet) throw new Error("Worksheet was not created");
    expect(sheet.getCell("D7").value).toBe(0);
    expect(sheet.getCell("E7").value).toMatchObject({ result: 2 });
    expect(() => monthlyProductionDrilldownUrl("javascript:alert(1)", 1533, ["2026-09"]))
      .toThrow("Invalid ERP address");
    expect(() => monthlyProductionDrilldownUrl(input.appOrigin, -1, ["2026-09"]))
      .toThrow("Invalid monthly production drill-down link");
  });

  it("rejects month data that cannot reconcile with column labels", () => {
    expect(() => buildMonthlyProductionExcelWorkbook({ ...input, monthLabels: ["Sep 2026"] }))
      .toThrow("Select at least one valid month");
    expect(() => buildMonthlyProductionExcelWorkbook({
      ...input, rows: [{ ...input.rows[0], values: [5, 2] }],
    })).toThrow("mismatched month");
  });
});
