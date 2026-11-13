/**
 * Phase 5 regression: the shared operational adapter must not corrupt
 * import-compatible sheets, typed ERP values or per-sheet ordering.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { canSeePosExcelFinancials } from "../../client/src/pages/pos/hooks/posExcelPermissions";
import {
  columnsFromOperationalRows,
  exportOperationalWorkbook,
} from "../../client/src/lib/operationalExcelExport";
import {
  buildUniversalExcelWorkbook,
  type UniversalExcelWorkbookSpec,
} from "../../shared/universal-excel/engine";

const mocked = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/lib/universalExcelExport", () => ({
  downloadUniversalExcelWorkbook: mocked.download,
}));

beforeEach(() => {
  mocked.download.mockReset();
  mocked.download.mockResolvedValue([]);
});

describe("Phase 5 operational workbook adapter", () => {
  it("uses every row to discover late-appearing fields and preserves field order", () => {
    const rows = Array.from({ length: 205 }, (_, i): Record<string, unknown> =>
      i === 204 ? { Code: "B205", Qty: 1, "Location Price": 5.25 } : { Code: "B" + i, Qty: 1 },
    );
    const columns = columnsFromOperationalRows(rows, {
      orderedHeaders: ["Code", "Qty"],
      types: { Qty: "decimal", "Location Price": "money" },
    });
    expect(columns.map(c => c.header)).toEqual(["Code", "Qty", "Location Price"]);
    const spec: UniversalExcelWorkbookSpec = {
      schemaVersion: 1, mode: "report", title: "ERP Stock",
      sheets: [{ name: "Stock", kind: "table", columns, rows }],
    };
    const { workbook } = buildUniversalExcelWorkbook(spec);
    expect(workbook.getWorksheet("Stock")!.getCell("C210").value).toBe(5.25);
  });

  it("protects text codes and formula-looking notes while preserving native numeric cells", async () => {
    const rows = [{
      "Article Code": "0000123",
      Qty: 3,
      Amount: 24.5,
      Notes: "=HYPERLINK(\"not-a-formula\")",
    }];
    const { workbook } = buildUniversalExcelWorkbook({
      schemaVersion: 1, mode: "report", title: "Stock",
      sheets: [{
        kind: "table", name: "Stock",
        columns: columnsFromOperationalRows(rows, {
          types: { Qty: "decimal", Amount: "money" },
        }),
        rows,
      }],
    });
    const first = workbook.getWorksheet("Stock")!;
    expect(first.getCell("A6").value).toBe("0000123");
    expect(first.getCell("B6").value).toBe(3);
    expect(first.getCell("C6").value).toBe(24.5);
    expect(first.getCell("D6").value).toBe("'=HYPERLINK(\"not-a-formula\")");
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(bytes);
    expect(reopened.getWorksheet("Stock")!.getCell("A6").value).toBe("0000123");
    expect(reopened.getWorksheet("Stock")!.getCell("C6").value).toBe(24.5);
  });

  it("sends a branded report specification with exact filename, rows and filters", async () => {
    const rows = [{ Code: "C1", Amount: 2.5 }];
    await exportOperationalWorkbook({
      title: "Containers", fileName: "containers.xlsx",
      companyName: "HMD", currencyCode: "USD",
      filters: [{ label: "Status", value: "OTW" }],
      sheets: [{
        name: "Containers",
        rows,
        columns: columnsFromOperationalRows(rows, { types: { Amount: "money" } }),
      }],
    });
    expect(mocked.download).toHaveBeenCalledTimes(1);
    const [spec, filename] = mocked.download.mock.calls[0];
    expect(filename).toBe("containers.xlsx");
    expect(spec.mode).toBe("report");
    expect(spec.companyName).toBe("HMD");
    expect(spec.currencyCode).toBe("USD");
    expect(spec.filters).toEqual([{ label: "Status", value: "OTW" }]);
    expect(spec.sheets[0].rows).toBe(rows);
    expect(spec.sheets[0].strictColumns).toBe(true);
  });

  it("leaves re-importable OTW and POS price-list headings at row 1", () => {
    for (const testCase of [
      { name: "OTW Containers", record: { "Container #": "MSKU1234", Shop: "Jnah" } },
      { name: "Price List", record: { Code: "000123", "Item Name": "Cotton", "Shop A": 14 } },
    ]) {
      const rows = [testCase.record];
      const { workbook } = buildUniversalExcelWorkbook({
        schemaVersion: 1, mode: "import-template", title: "Import-safe",
        sheets: [{
          name: testCase.name,
          kind: "table",
          columns: columnsFromOperationalRows(rows),
          rows,
        }],
      });
      const ws = workbook.getWorksheet(testCase.name)!;
      expect(ws.getCell("A1").value).toBe(Object.keys(testCase.record)[0]);
      expect(ws.getCell("A2").value).toBe(Object.values(testCase.record)[0]);
      expect(ws.getCell("A4").value).toBeNull();
    }
  });

  it("retains the exact stock-flow four-sheet order and unmodified summary values", () => {
    const summary = [{ Metric: "Gross Profit", Value: -450.25 }];
    const stock = [{ Code: "B1", Qty: 12 }];
    const adjustments = [{ Code: "B1", Direction: "Stock Out", Qty: -2 }];
    const sales = [{ Code: "B1", Amount: 800.25 }];
    const spec: UniversalExcelWorkbookSpec = {
      schemaVersion: 1, mode: "report", title: "Stock Flow",
      sheets: [
        { kind: "table", name: "Summary", columns: columnsFromOperationalRows(summary), rows: summary },
        { kind: "table", name: "Container Stock In", columns: columnsFromOperationalRows(stock), rows: stock },
        { kind: "table", name: "Stock Adjustments", columns: columnsFromOperationalRows(adjustments), rows: adjustments },
        { kind: "table", name: "Sales", columns: columnsFromOperationalRows(sales), rows: sales },
      ],
    };
    const wb = buildUniversalExcelWorkbook(spec).workbook;
    expect(wb.worksheets.map(ws => ws.name)).toEqual([
      "Summary", "Container Stock In", "Stock Adjustments", "Sales",
    ]);
    expect(wb.getWorksheet("Summary")!.getCell("B6").value).toBe(-450.25);
    expect(wb.getWorksheet("Stock Adjustments")!.getCell("C6").value).toBe(-2);
  });

  it("includes correctly ordered headers for an explicitly empty ERP report", () => {
    const columns = columnsFromOperationalRows([], {
      orderedHeaders: ["Code", "Item", "Qty"],
    });
    const { workbook } = buildUniversalExcelWorkbook({
      schemaVersion: 1, mode: "report", title: "Empty",
      sheets: [{ kind: "table", name: "Inventory", columns, rows: [] }],
    });
    const ws = workbook.getWorksheet("Inventory")!;
    expect([1, 2, 3].map(i => ws.getRow(5).getCell(i).value)).toEqual(["Code", "Item", "Qty"]);
    expect(ws.getCell("A6").value).toBeNull();
  });

  it("rejects unapproved fields instead of silently omitting data", () => {
    const spec: UniversalExcelWorkbookSpec = {
      schemaVersion: 1, mode: "report", title: "Strict",
      sheets: [{
        kind: "table", name: "Strict",
        columns: [{ key: "Code", header: "Code" }],
        rows: [{ Code: "B1", hiddenExtra: "must not vanish" }],
      }],
    };
    expect(() => buildUniversalExcelWorkbook(spec)).toThrow(/Unmapped Excel export column/);
  });
});

describe("POS financial export access", () => {
  it("permits active Admin, Owner and Developer roles only", () => {
    for (const role of ["Admin", "Owner", "Developer"]) {
      expect(canSeePosExcelFinancials({ role, currentRole: role })).toBe(true);
    }
    for (const role of ["POS", "View Only", "Manager", "Tester", "Create Only"]) {
      expect(canSeePosExcelFinancials({ role })).toBe(false);
    }
  });

  it("enforces active role, hidden stock rates and POS view-only mode", () => {
    expect(canSeePosExcelFinancials({ role: "Admin", currentRole: "View Only" })).toBe(false);
    expect(canSeePosExcelFinancials({ role: "Admin", hiddenErpCostFields: ["stock_rates"] })).toBe(false);
    expect(canSeePosExcelFinancials({ role: "Owner", posViewOnly: true })).toBe(false);
    expect(canSeePosExcelFinancials(null)).toBe(false);
  });
});
