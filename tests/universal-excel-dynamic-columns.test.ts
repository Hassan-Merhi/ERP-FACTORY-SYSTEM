/**
 * Phase 4: smart column schemas and complete-dataset discovery.
 *
 * Runs in backend Vitest; no database, network or browser dependencies.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  buildUniversalExcelDimensionColumns,
  buildLocationPriceColumns,
  buildProductionMonthColumns,
  buildCurrencyColumns,
  buildAttributeColumns,
  composeUniversalExcelColumns,
  selectUniversalExcelConditionalColumns,
} from "../shared/universal-excel/columns";
import {
  buildStockItemReportColumns,
  buildProductionReportColumns,
  buildFactoryDaybookReportColumns,
  buildFinanceCurrencyReportColumns,
  buildAgentStatementReportColumns,
  buildCustomAttributeReportColumns,
} from "../shared/universal-excel/reportSchemas";
import { buildUniversalExcelWorkbook, type UniversalExcelColumn, type UniversalExcelWorkbookSpec } from "../shared/universal-excel/engine";
import { addSheet } from "../server/services/export-excel/sheet-helpers";

const sheet = (columns: readonly UniversalExcelColumn[], rows: readonly Record<string, unknown>[], tags: string[] = []) => {
  const spec: UniversalExcelWorkbookSpec = {
    schemaVersion: 1,
    mode: "report",
    title: "Dynamic Test",
    allowedColumnTags: tags,
    sheets: [{ name: "Dynamic", kind: "table", columns, rows }],
  };
  const result = buildUniversalExcelWorkbook(spec);
  return { ...result, ws: result.workbook.getWorksheet("Dynamic")! };
};

function stockRow(prices: Record<string, string> = {}): Record<string, unknown> {
  return {
    code: "000123",
    name: "Cotton Bale",
    barcode: "001122",
    aliasCodes: "BALE-A",
    uom: "BAL",
    stockGroup: "Mixed",
    grade: "A",
    category: "Textile",
    defaultSellingPrice: "12.35",
    costDubai: "9.10",
    pricesByLocation: prices,
    active: "Yes",
  };
}

async function xlsxRoundTrip(workbook: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const content = Buffer.from(await workbook.xlsx.writeBuffer());
  expect(content.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(content);
  return reopened;
}

describe("Phase 4: ERP stock smart location prices", () => {
  it("places alphabetical location prices after Cost Dubai and before Active", async () => {
    const columns = buildStockItemReportColumns([
      { id: 7, name: "Zahle" },
      { id: 3, name: "Achrafieh" },
      { id: 5, name: "Hamra" },
    ]);
    expect(columns.map(c => c.header).slice(-5)).toEqual([
      "Cost Dubai", "Price - Achrafieh", "Price - Hamra", "Price - Zahle", "Active",
    ]);
    const result = sheet(columns, [stockRow({ "3": "13.50", "5": "14.25" })], ["stock-rates", "stock-cost"]);
    expect(result.ws.getRow(5).getCell(11).value).toBe("Price - Achrafieh");
    expect(result.ws.getRow(6).getCell(11).value).toBe(13.5);
    expect(result.ws.getRow(6).getCell(12).value).toBe(14.25);
    expect(result.ws.getRow(6).getCell(13).value).toBe(12.35); // explicit default fallback
    expect(result.ws.getRow(6).getCell(1).value).toBe("000123");
    const restored = await xlsxRoundTrip(result.workbook);
    expect(restored.getWorksheet("Dynamic")!.getCell("M6").value).toBe(12.35);
  });

  it("excludes all cost and price columns when required tags are absent", () => {
    const columns = buildStockItemReportColumns([{ id: 1, name: "Factory" }]);
    const result = sheet(columns, [stockRow({ "1": "15" })]);
    expect(result.results[0].columns).toEqual([
      "code", "name", "barcode", "aliasCodes", "uom",
      "stockGroup", "grade", "category", "active",
    ]);
    expect(result.ws.getRow(6).getCell(9).value).toBe("Yes");
    expect(result.ws.getCell("J6").value).toBeNull();
  });

  it("rejects duplicate names and duplicate IDs rather than silently overwriting prices", () => {
    expect(() => buildLocationPriceColumns([
      { id: 1, name: "Mali" }, { id: 2, name: "mali" },
    ])).toThrow(/Duplicate dynamic Excel dimension/);
    expect(() => buildLocationPriceColumns([
      { id: 1, name: "Lshi" }, { id: 1, name: "Other" },
    ])).toThrow(/Duplicate dynamic Excel dimension/);
  });

  it("requires both family and member visibility tags for dimension pricing", () => {
    const columns = buildUniversalExcelDimensionColumns({
      namespace: "custom_price",
      sourceKey: "prices",
      dimensions: [
        { id: "1", label: "A", permissionTag: "shop-a" },
        { id: "2", label: "B" },
      ],
      type: "money",
      permissionTag: "rates",
    });
    const row = { prices: { "1": 11, "2": 12 } };
    const base = [{ key: "code", header: "Code" }, ...columns];
    const onlyMember = sheet(base, [{ code: "A", ...row }], ["shop-a"]);
    expect(onlyMember.results[0].columns).toEqual(["code"]);
    const onlyFamily = sheet(base, [{ code: "A", ...row }], ["rates"]);
    expect(onlyFamily.results[0].columns).toEqual(["code", "custom_price__2"]);
    const both = sheet(base, [{ code: "A", ...row }], ["rates", "shop-a"]);
    expect(both.results[0].columns).toEqual(["code", "custom_price__1", "custom_price__2"]);
  });

  it("does not include explicitly disabled locations", () => {
    const cols = buildLocationPriceColumns([
      { id: 1, name: "Beirut" }, { id: 2, name: "Lshi", enabled: false },
    ]);
    expect(cols.map(c => c.header)).toEqual(["Price - Beirut"]);
  });
});

describe("Phase 4: Factory month columns", () => {
  it("sorts months chronologically while retaining original source-array indices", () => {
    const months = [
      { period: "2026-11", label: "Nov 2026" },
      { period: "2026-01", label: "Jan 2026" },
      { period: "2026-08", label: "Aug 2026" },
    ];
    const columns = buildProductionReportColumns(months, { sourceKey: "values", sourceFormat: "array" });
    expect(columns.map(c => c.header)).toEqual([
      "Item Name", "Article Code", "Category",
      "Jan 2026", "Aug 2026", "Nov 2026", "Total Bales",
    ]);
    const r = sheet(columns, [{
      name: "Bales", articleCode: "001", categoryName: "Wipers",
      values: [11, 1, 8], totalBales: 20,
    }]);
    expect([4, 5, 6].map(column => r.ws.getRow(6).getCell(column).value)).toEqual([1, 8, 11]);
    expect(r.ws.getCell("G6").value).toBe(20);
  });

  it("supports record-valued month counts and rejects invalid month strings", () => {
    const columns = buildProductionMonthColumns([
      { period: "2025-12", label: "Dec 2025" },
      { period: "2026-01", label: "Jan 2026" },
    ]);
    const r = sheet(columns, [{ monthCounts: { "2025-12": 7, "2026-01": 9 } }]);
    expect(r.ws.getCell("A6").value).toBe(7);
    expect(r.ws.getCell("B6").value).toBe(9);
    expect(() => buildProductionMonthColumns([{ period: "2026-13", label: "Invalid" }])).toThrow(/Invalid Excel month period/);
  });

  it("does not turn missing production counts into invented zeros", () => {
    const cols = buildProductionMonthColumns([{ period: "2026-05", label: "May 2026" }]);
    const r = sheet(cols, [{ monthCounts: {} }]);
    expect(r.ws.getCell("A6").value).toBeNull();
  });
});

describe("Phase 4: currencies, FX and optional financial fields", () => {
  it("inserts per-currency amount and 6-decimal FX columns before USD totals", async () => {
    const columns = buildFinanceCurrencyReportColumns(["USD", "EUR"], { includeFxRates: true });
    expect(columns.map(c => c.header)).toEqual([
      "Date", "Description", "Amount (EUR)", "Amount (USD)",
      "FX Rate (EUR)", "FX Rate (USD)", "Total USD",
    ]);
    const r = sheet(columns, [{
      date: "2026-11-13",
      description: "Incoming stock",
      amountsByCurrency: { USD: 10, EUR: 8.5 },
      fxRatesByCurrency: { USD: 1, EUR: 1.125678 },
      totalUsd: 19.56,
    }]);
    expect(r.ws.getCell("E6").value).toBe(1.125678);
    expect(r.ws.getCell("E6").numFmt).toBe("#,##0.000000");
    expect(r.ws.getCell("G6").value).toBe(19.56);
    const restored = await xlsxRoundTrip(r.workbook);
    expect(restored.getWorksheet("Dynamic")!.getCell("C6").value).toBe(8.5);
  });

  it("only includes optional FX fields when explicitly enabled", () => {
    const summary = buildFactoryDaybookReportColumns("summary");
    const detail = buildFactoryDaybookReportColumns("detailed");
    expect(summary.map(c => c.header)).toEqual([
      "Date", "Type", "Description", "Currency",
      "Amount", "FX Rate", "Amount (USD)", "Optional",
    ]);
    expect(detail.map(c => c.header)).toEqual([
      "Date", "Type", "Description", "Currency",
      "Amount", "Amount (USD)", "Optional", "Account Name", "Debit", "Credit",
    ]);
    expect(buildAgentStatementReportColumns().map(c => c.key)).not.toContain("fxRate");
    expect(buildAgentStatementReportColumns({ fxRate: true }).map(c => c.key)).toContain("fxRate");
  });

  it("does not display tagged sensitive currency columns without access", () => {
    const columns = buildFinanceCurrencyReportColumns(["EUR"], { hideCost: true });
    const r = sheet(columns, [{
      date: "2026-11-13", description: "Test",
      amountsByCurrency: { EUR: 10 }, totalUsd: 12,
    }]);
    expect(r.results[0].columns).toEqual(["date", "description", "totalUsd"]);
    expect(r.ws.getCell("C6").value).toBe(12);
    expect(r.ws.getCell("D6").value).toBeNull();
  });

  it("rejects nonstandard currency codes", () => {
    expect(() => buildCurrencyColumns(["usd"], { measure: "amount" })).toThrow(/Invalid Excel currency code/);
    expect(() => buildCurrencyColumns(["EURO"], { measure: "fx-rate" })).toThrow(/Invalid Excel currency code/);
  });
});

describe("Phase 4: custom attributes, conditional columns and strict validation", () => {
  it("outputs typed additional attributes in alphabetical order", () => {
    const columns = buildCustomAttributeReportColumns(
      [{ key: "code", header: "Code" }],
      [{ id: "size", label: "Size", type: "integer" }, { id: "grade", label: "Grade" }],
    );
    expect(columns.map(c => c.header)).toEqual(["Code", "Grade", "Size"]);
    const r = sheet(columns, [{ code: "001", attributes: { size: "44", grade: "A" } }]);
    expect(r.ws.getCell("C6").value).toBe(44);
  });

  it("keeps conditional exports deterministic and rejects duplicate composition", () => {
    expect(selectUniversalExcelConditionalColumns([
      { enabled: false, column: { key: "secret", header: "Secret" } },
      { enabled: true, column: { key: "other", header: "Other" } },
    ]).map(c => c.key)).toEqual(["other"]);

    expect(() => composeUniversalExcelColumns(
      [{ key: "a", header: "A" }], [{ after: "a", columns: [{ key: "a", header: "Again" }] }],
    )).toThrow(/Duplicate Excel column key/);
    expect(() => composeUniversalExcelColumns(
      [{ key: "a", header: "A" }], [{ after: "missing", columns: [{ key: "b", header: "B" }] }],
    )).toThrow(/Unknown Excel column insertion anchor/);
    expect(composeUniversalExcelColumns([{ key: "a", header: "A" }], [
      { after: "a", columns: [{ key: "b", header: "B" }] },
      { after: "a", columns: [{ key: "c", header: "C" }] },
    ]).map(c => c.key)).toEqual(["a", "b", "c"]);
  });

  it("rejects nested fields that have no declared derived-column source", () => {
    expect(() => sheet(
      [{ key: "code", header: "Code" }],
      [{ code: "001", hiddenUnexpected: { x: 1 } }],
    )).toThrow(/Unmapped Excel export column/);
    expect(() => sheet(
      [{ key: "derived", header: "Derived", value: row => row.unmapped }],
      [{ unmapped: 10 }],
    )).toThrow(/Invalid or duplicate column/);
  });

  it("rejects malformed source structures and doesn't reinterpret formulas in dimension values", () => {
    const columns = buildLocationPriceColumns([{ id: 2, name: "Shop" }]);
    expect(() => sheet(columns, [{ pricesByLocation: "not-an-object" }])).toThrow(/Expected Excel column record/);
    const code = buildAttributeColumns([{ id: "code", label: "Code" }]);
    const r = sheet(code, [{ attributes: { code: "=HYPERLINK(\"evil\")" } }]);
    expect(r.ws.getCell("A6").value).toBe("'=HYPERLINK(\"evil\")");
  });

  it("discovers an allowlisted column whose source first appears after row 200", () => {
    const dynamic = buildProductionMonthColumns([{ period: "2026-11", label: "Nov" }]);
    const source = Array.from({ length: 230 }, (_, index) =>
      index === 229 ? { code: "A230", monthCounts: { "2026-11": 15 } } : { code: "A" + index });
    const spec: UniversalExcelWorkbookSpec = {
      schemaVersion: 1, title: "Sparse", mode: "report",
      sheets: [{
        name: "Sparse", kind: "table",
        columns: [{ key: "code", header: "Code" }],
        discoverColumns: dynamic,
        rows: source,
      }],
    };
    const r = buildUniversalExcelWorkbook(spec);
    expect(r.results[0].columns).toEqual(["code", "production_month__2026-11"]);
    expect(r.workbook.getWorksheet("Sparse")!.getCell("B235").value).toBe(15);
  });
});

describe("Phase 4: full-company data export retains all fields", () => {
  it("discovers new fields after the first 200 rows without changing first-row headers or formats", () => {
    const rows: Record<string, unknown>[] = Array.from(
      { length: 210 }, (_, index) => ({ ref_code: "B" + index }),
    );
    rows[209].late_total_amount = 125.75;
    const wb = new ExcelJS.Workbook();
    addSheet(wb, "Factory Stock", rows);
    const ws = wb.getWorksheet("Factory Stock")!;
    expect(ws.getRow(1).values).toEqual([undefined, "Ref Code", "Late Total Amount"]);
    expect(ws.getCell("B211").value).toBe(125.75);
    expect(ws.getColumn(2).numFmt).toBe("#,##0.00");
    expect(ws.autoFilter).toMatchObject({ from: { row: 1, column: 1 } });
  });

  it("keeps empty workbook sheets hidden and preserves nonmutating input data", () => {
    const wb = new ExcelJS.Workbook();
    const rows = [{ code: "001" }, { code: "002", notes: "new" }];
    const original = JSON.stringify(rows);
    addSheet(wb, "Full", rows);
    addSheet(wb, "Empty", []);
    expect(wb.getWorksheet("Empty")?.state).toBe("hidden");
    expect(JSON.stringify(rows)).toBe(original);
  });
});
