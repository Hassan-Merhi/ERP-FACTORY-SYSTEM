import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  DEFAULT_EXCEL_APPEARANCE_SETTINGS,
  excelAppearanceSettingsSchema,
  parseSavedExcelAppearance,
  validateExcelAppearance,
} from "../shared/universal-excel/appearanceSettings";
import { buildUniversalExcelWorkbook } from "../shared/universal-excel/engine";
import { styleSpecializedWorkbook } from "../shared/universal-excel/specializedWorkbookStyle";
import { resolveUniversalExcelAppearance } from "../shared/universal-excel/design";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";

function report(appearance = DEFAULT_EXCEL_APPEARANCE_SETTINGS) {
  return buildUniversalExcelWorkbook({
    schemaVersion: 1,
    title: "Sales by Location",
    companyName: "Kinshasa",
    mode: "report",
    appearance,
    exportedAt: new Date("2026-11-14T12:00:00Z"),
    sheets: [
      {
        kind: "table",
        name: "Sales",
        columns: [
          { key: "code", header: "Article Code" },
          { key: "qty", header: "Quantity", type: "integer" },
          { key: "price", header: "Unit Price", type: "money" },
          { key: "currency", header: "Currency" },
          { key: "total", header: "Total", type: "money" },
        ],
        rows: [{ code: "000045", qty: 2, price: 19.5, currency: "USD", total: 39 }],
      },
    ],
  }).workbook;
}

describe("Phase 9 company-scoped Excel appearance contract", () => {
  it("round trips a complete validated appearance without losing fields", () => {
    const input = {
      ...DEFAULT_EXCEL_APPEARANCE_SETTINGS,
      brandName: "DAKZO EAST AFRICA",
      accentColor: "#257A9D",
      preset: "slate" as const,
      logoDataUrl: tinyPng,
      headerText: "Custom Header",
      footerText: "Confidential",
      showExportDate: false,
      dateFormat: "mm/dd/yyyy" as const,
    };
    expect(validateExcelAppearance(input)).toEqual(input);
    expect(parseSavedExcelAppearance(JSON.stringify(input))).toEqual(input);
    expect(resolveUniversalExcelAppearance(input).palette.primary).toBe("FF257A9D");
  });

  it("rejects javascript URLs, fake images, oversized image strings and Excel print injection", () => {
    const replace = (part: Record<string, unknown>) => ({
      ...DEFAULT_EXCEL_APPEARANCE_SETTINGS,
      ...part,
    });
    const invalid = [
      { logoDataUrl: "https://example.com/tracker.png" },
      { logoDataUrl: "javascript:alert(1)" },
      { logoDataUrl: "data:image/svg+xml;base64,PHN2Zz4=" },
      { logoDataUrl: "data:image/png;base64,AAAA" },
      { logoDataUrl: "data:image/png;base64," + "A".repeat(184000) },
      { headerText: "&P&N" },
      { footerText: "line\nbreak" },
      { brandName: "bad\rname" },
      { accentColor: "#GG0000" },
      { showBranding: "yes" },
      { companyId: 999 },
    ];
    for (const value of invalid) {
      expect(excelAppearanceSettingsSchema.safeParse(replace(value)).success).toBe(false);
    }
    expect(parseSavedExcelAppearance('{"brandName":"only"}')).toEqual(DEFAULT_EXCEL_APPEARANCE_SETTINGS);
    expect(parseSavedExcelAppearance("{bad")).toEqual(DEFAULT_EXCEL_APPEARANCE_SETTINGS);
  });

  it("renders logos only in report metadata while retaining native numeric cells and row-5 headers", async () => {
    const wb = report({ ...DEFAULT_EXCEL_APPEARANCE_SETTINGS, logoDataUrl: tinyPng });
    const ws = wb.getWorksheet("Sales")!;
    expect(ws.getImages()).toHaveLength(1);
    expect(ws.getCell("A5").value).toBe("Article Code");
    expect(ws.getCell("A6").value).toBe("000045");
    expect(ws.getCell("B6").value).toBe(2);
    expect(ws.getCell("E6").value).toBe(39);
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(reopened.getWorksheet("Sales")!.getImages()).toHaveLength(1);
    expect(reopened.getWorksheet("Sales")!.getCell("E6").value).toBe(39);
  });

  it("applies company/date visibility, header and footer text without altering prices", () => {
    const wb = report({
      ...DEFAULT_EXCEL_APPEARANCE_SETTINGS,
      showCompanyName: false,
      showExportDate: false,
      headerText: "Daily Sales",
      footerText: "Internal",
      dateFormat: "mm/dd/yyyy",
    });
    const ws = wb.getWorksheet("Sales")!;
    expect(String(ws.getCell("A2").value)).not.toContain("Kinshasa");
    expect(String(ws.getCell("A2").value)).not.toContain("Exported:");
    expect(ws.headerFooter.oddHeader).toContain("Daily Sales");
    expect(ws.headerFooter.oddFooter).toContain("Internal");
    expect(ws.getCell("C6").value).toBe(19.5);
  });

  it("keeps strict import templates completely untouched, even when appearance is supplied", () => {
    const { workbook } = buildUniversalExcelWorkbook({
      schemaVersion: 1,
      title: "Customer Import",
      mode: "import-template",
      appearance: { ...DEFAULT_EXCEL_APPEARANCE_SETTINGS, logoDataUrl: tinyPng },
      sheets: [
        {
          kind: "table",
          name: "Price List",
          columns: [
            { key: "code", header: "article_code" },
            { key: "price", header: "price", type: "money" },
          ],
          rows: [{ code: "000999", price: 13.5 }],
        },
      ],
    });
    const sheet = workbook.getWorksheet("Price List")!;
    expect(sheet.getCell("A1").value).toBe("article_code");
    expect(sheet.getCell("A2").value).toBe("000999");
    expect(sheet.getCell("B2").value).toBe(13.5);
    expect(sheet.getImages()).toHaveLength(0);
    expect(sheet.headerFooter.oddHeader).toBeFalsy();
  });

  it("custom print settings respect existing invoice/truck print headers and preserve formulas", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Truck Trip");
    ws.addRow(["Item", "Quantity", "Amount"]);
    ws.addRow(["000001", 2, { formula: "2*11.5", result: 23 }]);
    ws.headerFooter.oddHeader = "&LExisting invoice header";
    ws.headerFooter.oddFooter = "&RPage &P";
    styleSpecializedWorkbook(wb, {
      sheets: [{ name: "Truck Trip" }],
      appearance: {
        ...DEFAULT_EXCEL_APPEARANCE_SETTINGS,
        headerText: "Should not replace",
        footerText: "Not replaced",
      },
    });
    expect(ws.headerFooter.oddHeader).toBe("&LExisting invoice header");
    expect(ws.headerFooter.oddFooter).toBe("&RPage &P");
    expect(ws.getCell("C2").value).toEqual({ formula: "2*11.5", result: 23 });
  });
});
