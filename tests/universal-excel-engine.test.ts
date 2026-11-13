import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildUniversalExcelWorkbook,
  UNIVERSAL_EXCEL_SCHEMA_VERSION,
  type UniversalExcelWorkbookSpec,
} from "../shared/universal-excel/engine";
import { validateUniversalExcelFilename } from "../shared/universal-excel/filename";

function report(overrides: Partial<UniversalExcelWorkbookSpec> = {}): UniversalExcelWorkbookSpec {
  return {
    schemaVersion: UNIVERSAL_EXCEL_SCHEMA_VERSION,
    title: "Stock Items",
    mode: "report",
    exportedAt: new Date(2026, 10, 13, 10),
    companyName: "Factory Test",
    dateFormat: "dd/mm/yyyy",
    filters: [{ label: "Status", value: "Active" }],
    sheets: [{
      kind: "table",
      name: "Stock Items",
      columns: [
        { key: "code", header: "Article Code", type: "text" },
        { key: "qty", header: "Qty", type: "integer" },
        { key: "cost", header: "Cost", type: "money", permissionTag: "cost" },
      ],
      rows: [{ code: "00123", qty: 2, cost: 4.25 }],
    }],
    ...overrides,
  };
}

async function roundTrip(spec: UniversalExcelWorkbookSpec): Promise<ExcelJS.Workbook> {
  const { workbook } = buildUniversalExcelWorkbook(spec);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(bytes);
  return reloaded;
}

describe("universal Excel engine: report and safety contracts", () => {
  it("creates a valid branded report with real numeric values and text-preserved identifiers", async () => {
    const wb = await roundTrip(report({ allowedColumnTags: ["cost"] }));
    const sheet = wb.getWorksheet("Stock Items")!;
    expect(sheet.getCell("A1").value).toBe("Stock Items");
    expect(sheet.getCell("A2").value).toContain("Factory Test");
    expect(sheet.getCell("A2").value).toContain("13/11/2026");
    expect(sheet.getCell("A3").value).toBe("Filters: Status: Active");
    expect(sheet.getCell("A5").value).toBe("Article Code");
    expect(sheet.getCell("B5").value).toBe("Qty");
    expect(sheet.getCell("A6").value).toBe("00123");
    expect(sheet.getCell("B6").value).toBe(2);
    expect(sheet.getCell("C6").value).toBe(4.25);
    expect(sheet.getCell("C6").numFmt).toBe("#,##0.00");
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 5 });
    expect(sheet.autoFilter).toBeDefined();
  });

  it("omits restricted cost columns, even when cost data exists in input rows", () => {
    const { workbook, results } = buildUniversalExcelWorkbook(report());
    const sheet = workbook.getWorksheet("Stock Items")!;
    expect(results[0].columns).toEqual(["code", "qty"]);
    expect(sheet.getCell("B6").value).toBe(2);
    expect(sheet.getCell("C5").value).toBeNull();
    expect(sheet.getCell("C6").value).toBeNull();
  });

  it("discovers approved dynamic columns even if first present after the 200th row", () => {
    const rows = Array.from({ length: 250 }, (_, index) =>
      index === 249 ? { code: "B250", qty: 1, "Price - Lshi": 7.5 } : { code: "B" + index, qty: 1 });
    const spec = report({
      sheets: [{
        kind: "table",
        name: "Stock Items",
        columns: [
          { key: "code", header: "Code" },
          { key: "qty", header: "Qty", type: "integer" },
        ],
        discoverColumns: [{ key: "Price - Lshi", header: "Price - Lshi", type: "money" }],
        rows,
      }],
    });
    const { workbook, results } = buildUniversalExcelWorkbook(spec);
    expect(results[0].columns).toEqual(["code", "qty", "Price - Lshi"]);
    expect(workbook.getWorksheet("Stock Items")!.getCell("C255").value).toBe(7.5);
  });

  it("rejects unrecognized data keys instead of silently dropping them", () => {
    const spec = report({
      sheets: [{
        kind: "table",
        name: "Stock Items",
        columns: [{ key: "code", header: "Code" }],
        rows: [{ code: "B1" }, { code: "B2", lateField: "must not disappear" }],
      }],
    });
    expect(() => buildUniversalExcelWorkbook(spec)).toThrow(/Unmapped Excel export column: lateField/);
  });

  it("protects text cells from formula injection while permitting trusted formulas", async () => {
    const spec = report({
      sheets: [{
        kind: "table",
        name: "Test",
        columns: [
          { key: "name", header: "Name", type: "text" },
          { key: "total", header: "Total", type: "formula" },
        ],
        rows: [{ name: " =HYPERLINK(\"https://bad.example\")", total: { trustedFormula: "1+2", result: 3 } }],
      }],
    });
    const workbook = await roundTrip(spec);
    const sheet = workbook.getWorksheet("Test")!;
    expect(sheet.getCell("A6").value).toBe("' =HYPERLINK(\"https://bad.example\")");
    expect(sheet.getCell("B6").formula).toBe("1+2");
    expect(sheet.getCell("B6").result).toBe(3);
  });

  it("uses real dates and prevents timezone shifting of date-only strings", () => {
    const spec = report({
      dateFormat: "mm/dd/yyyy",
      sheets: [{
        kind: "table",
        name: "Dates",
        columns: [{ key: "when", header: "Date", type: "date" }],
        rows: [{ when: "2026-11-13" }],
      }],
    });
    const sheet = buildUniversalExcelWorkbook(spec).workbook.getWorksheet("Dates")!;
    const date = sheet.getCell("A6").value as Date;
    expect(date).toBeInstanceOf(Date);
    expect([date.getFullYear(), date.getMonth() + 1, date.getDate()]).toEqual([2026, 11, 13]);
    expect(sheet.getCell("A6").numFmt).toBe("mm/dd/yyyy");
  });

  it("supports grouped summaries and authoritative footers without recomputing accounting values", () => {
    const spec = report({
      sheets: [{
        kind: "grouped",
        name: "Grouped",
        columns: [
          { key: "item", header: "Item" },
          { key: "amount", header: "Amount", type: "money" },
        ],
        groups: [
          { label: "Supplier A", rows: [{ item: "A", amount: 10.5 }], footer: { item: "Subtotal", amount: 10.5 } },
          { label: "Supplier B", rows: [{ item: "B", amount: 3.25 }] },
        ],
        footer: { item: "Grand Total", amount: 13.75 },
      }],
    });
    const { workbook, results } = buildUniversalExcelWorkbook(spec);
    const sheet = workbook.getWorksheet("Grouped")!;
    expect(sheet.getCell("A6").value).toBe("Supplier A");
    expect(sheet.getCell("B7").value).toBe(10.5);
    expect(sheet.getCell("B8").value).toBe(10.5);
    expect(sheet.getCell("A9").value).toBe("Supplier B");
    expect(sheet.getCell("B10").value).toBe(3.25);
    expect(sheet.getCell("B11").value).toBe(13.75);
    expect(results[0].dataRows).toBe(4);
    expect(sheet.autoFilter).toBeUndefined();
  });

  it("preserves strict first-row headers and the exact A3:D3 import contract", async () => {
    const spec: UniversalExcelWorkbookSpec = {
      schemaVersion: 1,
      title: "Import template",
      mode: "import-template",
      sheets: [
        {
          kind: "table",
          name: "Supplier Returns",
          columns: [
            { key: "article_code", header: "article_code" },
            { key: "qty", header: "qty", type: "integer" },
          ],
          rows: [{ article_code: "HMD001", qty: 2 }],
        },
        {
          kind: "table",
          name: "Container Items",
          headerRow: 3,
          prefaceRows: [["Container No. MSKU001"], []],
          columns: [
            { key: "no", header: "NO", type: "integer" },
            { key: "barcode", header: "BARCODE" },
            { key: "description", header: "DESCRIPTION" },
            { key: "qty", header: "Q'TY", type: "integer" },
          ],
          rows: [{ no: 1, barcode: "00000002", description: "Bale", qty: 2 }],
        },
      ],
    };
    const wb = await roundTrip(spec);
    expect(wb.worksheets.map(s => s.name)).toEqual(["Supplier Returns", "Container Items"]);
    expect(wb.worksheets[0].getCell("A1").value).toBe("article_code");
    expect(wb.worksheets[0].getCell("A2").value).toBe("HMD001");
    const ws = wb.worksheets[1];
    expect(ws.getCell("A1").value).toBe("Container No. MSKU001");
    expect(["A3", "B3", "C3", "D3"].map(a => ws.getCell(a).value)).toEqual(["NO", "BARCODE", "DESCRIPTION", "Q'TY"]);
    expect(ws.getCell("B4").value).toBe("00000002");
  });

  it("does not inject branding into custom invoice and matrix worksheets", () => {
    const spec = report({
      sheets: [{
        kind: "custom",
        name: "Special Invoice",
        build(ws) {
          ws.getCell("A1").value = "EXACT INVOICE";
          ws.getCell("B9").value = { formula: "SUM(B6:B8)", result: 12.25 };
          ws.mergeCells("A1:C1");
        },
      }],
    });
    const { workbook, results } = buildUniversalExcelWorkbook(spec);
    const ws = workbook.getWorksheet("Special Invoice")!;
    expect(ws.getCell("A1").value).toBe("EXACT INVOICE");
    expect(ws.getCell("B9").formula).toBe("SUM(B6:B8)");
    expect(results[0].kind).toBe("custom");
  });

  it("enforces required detail fields while allowing sparse total footers", () => {
    const valid = report({
      currencyCode: "USD",
      sheets: [{
        kind: "table",
        name: "Required",
        columns: [
          { key: "article", header: "Article", required: true },
          { key: "qty", header: "Quantity", type: "integer", required: true },
        ],
        rows: [{ article: "A", qty: 3 }],
        footer: { article: "TOTAL" },
      }],
    });
    const ws = buildUniversalExcelWorkbook(valid).workbook.getWorksheet("Required")!;
    expect(ws.getCell("A2").value).toContain("Currency: USD");
    expect(ws.getCell("A7").value).toBe("TOTAL");
    expect(ws.getCell("B7").value).toBeNull();

    const missing = report({
      sheets: [{
        kind: "table",
        name: "Required",
        columns: [{ key: "qty", header: "Quantity", type: "integer", required: true }],
        rows: [{ qty: null }],
      }],
    });
    expect(() => buildUniversalExcelWorkbook(missing)).toThrow(/Missing required Excel value/);
  });

  it("rejects duplicate columns, duplicate sheet names, invalid numeric values and untrusted formulas", () => {
    expect(() => buildUniversalExcelWorkbook(report({
      sheets: [{
        kind: "table",
        name: "Bad",
        columns: [{ key: "a", header: "A" }, { key: "a", header: "Again" }],
        rows: [],
      }],
    }))).toThrow(/duplicate column/i);
    expect(() => buildUniversalExcelWorkbook(report({
      sheets: [
        { kind: "table", name: "ABC", columns: [{ key: "a", header: "A" }], rows: [] },
        { kind: "table", name: "abc", columns: [{ key: "a", header: "A" }], rows: [] },
      ],
    }))).toThrow(/worksheet name/);
    expect(() => buildUniversalExcelWorkbook(report({
      sheets: [{ kind: "table", name: "Bad", columns: [{ key: "qty", header: "Qty", type: "integer" }], rows: [{ qty: "1.5" }] }],
    }))).toThrow(/numeric/);
    expect(() => buildUniversalExcelWorkbook(report({
      sheets: [{ kind: "table", name: "Bad", columns: [{ key: "v", header: "Formula", type: "formula" }], rows: [{ v: "=1+2" }] }],
    }))).toThrow(/trusted formula/);
  });
});

describe("universal Excel filenames", () => {
  it("accepts simple safe filenames and rejects traversal/control characters", () => {
    expect(validateUniversalExcelFilename("Factory_Stock_2026-11-13.xlsx")).toBe("Factory_Stock_2026-11-13.xlsx");
    for (const value of ["../secrets.xlsx", "a/b.xlsx", "foo.csv", ".xlsx", "a\nb.xlsx"]) {
      expect(() => validateUniversalExcelFilename(value)).toThrow(/Invalid Excel export filename/);
    }
  });
});
