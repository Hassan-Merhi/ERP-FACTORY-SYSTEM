// @vitest-environment node
/**
 * The Live Sheets editor opens an uploaded .xlsx in Fortune Sheet
 * (`excelToFortune`) and writes edits back into the original workbook
 * (`syncFortuneToXlsx`). Both run on real workbook bytes here: a workbook is
 * built with ExcelJS, converted, edited as Fortune Sheet cells, synced back,
 * and re-read with ExcelJS. A mapping regression — a lost formula, a dropped
 * merge, a colour written in the wrong byte order — shows up as a changed
 * spreadsheet for the user, so each is asserted at the byte level.
 *
 * Runs in the node environment: JSZip (inside ExcelJS) rejects ArrayBuffers
 * that cross into the jsdom realm, and nothing here touches the DOM.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { excelToFortune } from "@/lib/excelImport";
import { arrayBufferToBase64, base64ToArrayBuffer, isExcelMode, syncFortuneToXlsx } from "@/lib/excelSync";

async function buildWorkbook(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Stock");
  ws.columns = [{ width: 20 }, { width: 10 }, { width: 12, hidden: true }];

  ws.getCell("A1").value = "Item";
  ws.getCell("A1").font = {
    bold: true,
    italic: true,
    size: 14,
    name: "Arial",
    color: { argb: "FFFF0000" },
    strike: true,
    underline: true,
  };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00FF00" } };
  ws.getCell("A1").alignment = { horizontal: "center", vertical: "top", wrapText: true };
  ws.getCell("A1").border = { left: { style: "thin", color: { argb: "FF0000FF" } }, bottom: { style: "double" } };

  ws.getCell("B1").value = "Qty";
  ws.getCell("A2").value = "Bale";
  ws.getCell("B2").value = 12;
  ws.getCell("B2").numFmt = "0.00";
  ws.getCell("A3").value = "Sack";
  ws.getCell("B3").value = 8;
  ws.getCell("B4").value = { formula: "SUM(B2:B3)", result: 20 } as ExcelJS.CellValue;
  ws.getCell("A5").value = new Date(Date.UTC(2026, 8, 1));
  ws.getCell("A6").value = true;

  ws.mergeCells("C1:D2");
  ws.getRow(2).height = 30;
  ws.getRow(6).hidden = true;
  ws.autoFilter = "A1:B4";
  ws.addConditionalFormatting({
    ref: "B2:B3",
    rules: [
      {
        type: "cellIs",
        operator: "greaterThan",
        formulae: [10],
        priority: 1,
        style: {
          fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } },
          font: { bold: true, color: { argb: "FF112233" } },
        },
      } as any,
      { type: "top10", rank: 1, top: true, percent: false, priority: 2, style: { font: { italic: true } } } as any,
      { type: "expression", formulae: ["B2>0"], priority: 3 } as any,
    ],
  });

  wb.addWorksheet("Notes").getCell("A1").value = "second sheet";

  const buf = await wb.xlsx.writeBuffer();
  return (buf as Buffer).buffer.slice(
    (buf as Buffer).byteOffset,
    (buf as Buffer).byteOffset + (buf as Buffer).byteLength
  );
}

function cellAt(sheet: any, r: number, c: number) {
  return sheet.celldata.find((cell: any) => cell.r === r && cell.c === c)?.v;
}

describe("excelToFortune", () => {
  it("maps values, formulas, dates and booleans", async () => {
    const [stock] = await excelToFortune(await buildWorkbook());

    expect(cellAt(stock, 0, 0).v).toBe("Item");
    expect(cellAt(stock, 1, 1)).toMatchObject({ v: 12, ct: { fa: "0.00", t: "n" } });
    expect(cellAt(stock, 3, 1)).toMatchObject({ f: "SUM(B2:B3)", v: 20, m: "20" });
    expect(cellAt(stock, 4, 0).ct.t).toBe("d");
    expect(cellAt(stock, 4, 0).v).toBe(Date.UTC(2026, 8, 1));
    expect(cellAt(stock, 5, 0).ct.t).toBe("b");
  });

  it("maps font, fill, alignment and borders to Fortune codes", async () => {
    const [stock] = await excelToFortune(await buildWorkbook());
    const a1 = cellAt(stock, 0, 0);

    expect(a1).toMatchObject({
      bl: 1,
      it: 1,
      un: 1,
      cl: 1,
      fs: 14,
      ff: "Arial",
      fc: "#FF0000",
      bg: "#00FF00",
      ht: 0,
      vt: 1,
      tb: 2,
    });
    expect(a1.b.l).toEqual({ style: 1, color: "#0000FF" });
    expect(a1.b.b).toEqual({ style: 7, color: "#000000" });
  });

  it("maps merges, widths, hidden columns, row heights, hidden rows and sheet order", async () => {
    const sheets = await excelToFortune(await buildWorkbook());
    const [stock, notes] = sheets;

    expect(stock.config.merge["0_2"]).toEqual({ r: 0, c: 2, rs: 2, cs: 2 });
    expect(stock.config.columnlen).toMatchObject({ 0: 140, 1: 70 });
    expect(stock.config.colhidden).toEqual({ 2: 0 });
    expect(stock.config.rowlen[1]).toBe(Math.round(30 * 1.333));
    expect(stock.config.rowhidden).toEqual({ 5: 0 });
    expect(stock.status).toBe(1);
    expect(notes).toMatchObject({ name: "Notes", order: 1, status: 0 });
    expect(stock.row).toBeGreaterThanOrEqual(50);
    expect(stock.column).toBeGreaterThanOrEqual(26);
  });

  it("carries the auto filter range and supported conditional formats", async () => {
    const [stock] = await excelToFortune(await buildWorkbook());

    expect(stock.filter_select).toEqual({ row: [0, 3], column: [0, 1] });
    const types = (stock.conditions ?? []).map((c: any) => c.type);
    expect(types).toContain("cellIs");
    expect(types).toContain("top10");
    const cellIs = stock.conditions!.find((c: any) => c.type === "cellIs") as any;
    expect(cellIs.format).toEqual({ bg: "#FFFF00", fc: "#112233", bl: 1 });
    expect(cellIs.operator).toBe("greaterThan");
  });
});

describe("syncFortuneToXlsx", () => {
  it("writes edited values and styles back and keeps untouched workbook features", async () => {
    const original = await buildWorkbook();
    const raw = arrayBufferToBase64(original);
    const sheets = await excelToFortune(original);
    const stock: any = sheets[0];

    // Edit: change a quantity, restyle it, clear a label, add a new merge and sizes.
    cellAt(stock, 1, 1).v = 99;
    Object.assign(cellAt(stock, 1, 1), {
      bl: 1,
      fc: "#123456",
      bg: "#ABCDEF",
      ht: 2,
      vt: 2,
      tb: "2",
      b: { t: { style: 8, color: "#FF0000" }, r: { style: 99 } },
      ct: { fa: "#,##0", t: "n" },
    });
    stock.celldata = stock.celldata.filter((c: any) => !(c.r === 2 && c.c === 0));
    stock.config.merge = { "6_0": { r: 6, c: 0, rs: 1, cs: 3 } };
    stock.config.rowlen = { 0: 40 };
    stock.config.rowhidden = { 3: 0 };
    stock.config.columnlen = { 1: 140 };
    stock.config.colhidden = { 0: 0 };

    const out = await syncFortuneToXlsx(raw, sheets);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out);
    const ws = wb.getWorksheet("Stock")!;

    expect(ws.getCell("B2").value).toBe(99);
    expect(ws.getCell("B2").font).toMatchObject({ bold: true, color: { argb: "FF123456" } });
    expect((ws.getCell("B2").fill as any).fgColor.argb).toBe("FFABCDEF");
    expect(ws.getCell("B2").alignment).toMatchObject({ horizontal: "right", vertical: "bottom", wrapText: true });
    expect(ws.getCell("B2").border.top).toMatchObject({ style: "medium", color: { argb: "FFFF0000" } });
    expect(ws.getCell("B2").border.right).toBeUndefined();
    expect(ws.getCell("B2").numFmt).toBe("#,##0");

    expect(ws.getCell("A3").value).toBeNull();
    expect(ws.getCell("B4").formula).toBe("SUM(B2:B3)");
    expect(ws.getCell("A7").isMerged).toBe(true);
    expect(ws.getCell("C1").isMerged).toBe(false);
    expect(ws.getRow(1).height).toBe(Math.round(40 / 1.333));
    expect(ws.getRow(4).hidden).toBe(true);
    expect(ws.getColumn(2).width).toBe(20);
    expect(ws.getColumn(1).hidden).toBe(true);

    // Features Fortune Sheet never edits are preserved from the original file.
    expect(wb.getWorksheet("Notes")!.getCell("A1").value).toBe("second sheet");
  });

  it("matches sheets by index when a sheet was renamed in the editor, and skips unknown sheets", async () => {
    const original = await buildWorkbook();
    const sheets: any[] = await excelToFortune(original);
    sheets[1].name = "Renamed";
    cellAt(sheets[1], 0, 0).v = "edited";
    sheets.push({ name: "Ghost", celldata: [{ r: 0, c: 0, v: { v: "x" } }], config: {} });

    const out = await syncFortuneToXlsx(arrayBufferToBase64(original), sheets);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out);

    expect(wb.getWorksheet(2)!.getCell("A1").value).toBe("edited");
    expect(wb.worksheets).toHaveLength(2);
  });

  it("accepts dense `data` sheets and text-only cells", async () => {
    const original = await buildWorkbook();
    const dense: any = {
      name: "Stock",
      config: {},
      data: [[{ m: "from m" }, { v: 5, f: "2+3" }], null, [null, { v: null, m: "" }]],
    };
    const out = await syncFortuneToXlsx(arrayBufferToBase64(original), [dense]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out);
    const ws = wb.getWorksheet("Stock")!;

    expect(ws.getCell("A1").value).toBe("from m");
    expect(ws.getCell("B1").formula).toBe("2+3");
    expect(ws.getCell("B3").value).toBeNull();
  });
});

describe("spreadsheet storage helpers", () => {
  it("round-trips bytes through base64", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const back = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(bytes.buffer)));
    expect(Array.from(back)).toEqual(Array.from(bytes));
  });

  it("recognises only saved excel-mode payloads", () => {
    expect(isExcelMode({ mode: "excel", rawXlsx: "AAAA", sheets: [] })).toBe(true);
    expect(isExcelMode({ mode: "excel" })).toBe(false);
    expect(isExcelMode([{ name: "Sheet1" }])).toBe(false);
    expect(isExcelMode(null)).toBe(false);
  });
});
