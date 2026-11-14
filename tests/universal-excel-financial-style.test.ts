import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { styleUniversalFinancialWorkbook } from "../shared/universal-excel/financialWorkbookStyle";
import { buildUniversalExcelWorkbook } from "../shared/universal-excel/engine";

function ledger(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const statement = wb.addWorksheet("Statement");
  statement.addRow(["Date", "Particulars", "DR", "CR", "Balance"]);
  statement.addRow(["2026-11-13", "Opening Balance", null, null, -120.25]);
  statement.addRow(["2026-11-14", "Receipt", null, 20.25, -140.5]);
  statement.addRow(["2026-11-14", "Invoice", 150, null, 9.5]);
  statement.addRow(["CLOSING", "", 150, 20.25, { formula: "E2-D3+C4", result: 9.5 }]);
  statement.getColumn(5).numFmt = '#,##0.00 "DR";[Red]#,##0.00 "CR"';
  statement.getCell("E3").font = { color: { argb: "FFB91C1C" } };
  statement.autoFilter = { from: "A1", to: "E4" };
  statement.views = [{ state: "frozen", ySplit: 1 }];
  statement.pageSetup.printArea = "A1:E5";
  statement.headerFooter.oddFooter = "&LStatement&CPage &P of &N";
  const fx = wb.addWorksheet("Currency Detail");
  fx.addRow(["Native currency disclosure"]);
  fx.addRow(["Original rate", "1.123456"]);
  fx.addRow([]);
  fx.addRow([]);
  fx.addRow([]);
  fx.addRow([]);
  fx.addRow(["Currency", "Native Amount", "Historical USD"]);
  fx.addRow(["EUR", 150, 133.333333]);
  fx.getCell("A8").value = "EUR";
  return wb;
}

describe("Phase 7 financial workbook presentation", () => {
  it("preserves exact DR/CR values, signed balances, formulas and native FX after Excel round trip", async () => {
    const wb = ledger();
    styleUniversalFinancialWorkbook(wb, [
      { name: "Statement", headerRow: 1 },
      { name: "Currency Detail", headerRow: 7 },
    ]);
    expect(wb.creator).toBe("DAKZO SYSTEMS");
    const ws = wb.getWorksheet("Statement")!;
    expect(ws.getCell("E2").value).toBe(-120.25);
    expect(ws.getCell("D3").value).toBe(20.25);
    expect(ws.getCell("E3").value).toBe(-140.5);
    expect(ws.getCell("E4").value).toBe(9.5);
    expect(ws.getCell("E5").value).toEqual({ formula: "E2-D3+C4", result: 9.5 });
    expect(ws.getCell("E3").font.color?.argb).toBe("FFB91C1C");
    expect(ws.getColumn(5).numFmt).toContain("CR");
    expect(ws.pageSetup.printArea).toBe("A1:E5");
    expect(ws.headerFooter.oddFooter).toContain("&P");
    expect(ws.views).toEqual([{ state: "frozen", ySplit: 1 }]);
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(reopened.getWorksheet("Statement")!.getCell("E5").value)
      .toEqual({ formula: "E2-D3+C4", result: 9.5 });
    expect(reopened.getWorksheet("Statement")!.getCell("E3").value).toBe(-140.5);
    expect(reopened.getWorksheet("Currency Detail")!.getCell("C8").value).toBe(133.333333);
    expect(reopened.getWorksheet("Currency Detail")!.getCell("B2").value).toBe("1.123456");
  });

  it("never adds financial rows or alters conditional cost and FX status colors", () => {
    const wb = ledger();
    const ws = wb.getWorksheet("Statement")!;
    ws.getCell("D3").fill = {
      type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE1E1" },
    };
    const before = {
      rowCount: ws.rowCount,
      balanceFormat: ws.getColumn(5).numFmt,
      merges: [...ws.model.merges],
      values: [ws.getCell("C4").value, ws.getCell("D3").value, ws.getCell("E3").value],
    };
    styleUniversalFinancialWorkbook(wb, [
      { name: "Statement", headerRow: 1 },
      { name: "Currency Detail" },
    ]);
    expect(ws.rowCount).toBe(before.rowCount);
    expect(ws.model.merges).toEqual(before.merges);
    expect(ws.getColumn(5).numFmt).toBe(before.balanceFormat);
    expect([ws.getCell("C4").value, ws.getCell("D3").value, ws.getCell("E3").value])
      .toEqual(before.values);
    expect(ws.getCell("D3").fill).toEqual({
      type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE1E1" },
    });
  });

  it("preserves currency-separated sheets and skips absent print metadata on import contracts", () => {
    const wb = new ExcelJS.Workbook();
    const usd = wb.addWorksheet("USD");
    usd.addRow(["Date", "Amount", "Balance"]);
    usd.addRow(["2026-11-13", 12.5, -90]);
    const eur = wb.addWorksheet("EUR");
    eur.addRow(["Date", "Amount", "Balance"]);
    eur.addRow(["2026-11-13", 20.25, 30.75]);
    styleUniversalFinancialWorkbook(wb, [
      { name: "USD", headerRow: 1 },
      { name: "EUR", headerRow: 1 },
    ]);
    expect(wb.worksheets.map(ws => ws.name)).toEqual(["USD", "EUR"]);
    expect(usd.getCell("C2").value).toBe(-90);
    expect(eur.getCell("C2").value).toBe(30.75);
    expect(usd.headerFooter.oddHeader).toContain("DAKZO SYSTEMS");
  });

  it("fails on unsafe layout specifications rather than silently changing financial sheets", () => {
    const wb = ledger();
    expect(() => styleUniversalFinancialWorkbook(wb, [{ name: "Missing" }])).toThrow(/not found/);
    expect(() => styleUniversalFinancialWorkbook(wb, [{ name: "Statement", headerRow: 99 }]))
      .toThrow(/header position/);
    expect(() => styleUniversalFinancialWorkbook(wb, [
      { name: "Statement" }, { name: "Statement" },
    ])).toThrow(/Duplicate/);
  });

  it("keeps read-only cost-center numeric amounts and textual high-precision FX columns", () => {
    const { workbook } = buildUniversalExcelWorkbook({
      schemaVersion: 1, mode: "report", title: "Cost Center",
      sheets: [{
        name: "Cost Centers", kind: "table",
        columns: [
          { key: "account", header: "Account" },
          { key: "expense", header: "Expense", type: "auto" },
          { key: "native", header: "Native", type: "auto" },
        ],
        rows: [{
          account: "Current Expense", expense: -431.25,
          native: "1234567890123.123456",
        }],
      }],
    });
    const ws = workbook.getWorksheet("Cost Centers")!;
    expect(ws.getCell("B6").value).toBe(-431.25);
    expect(ws.getCell("C6").value).toBe("1234567890123.123456");
  });
});
