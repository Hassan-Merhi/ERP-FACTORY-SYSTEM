// @vitest-environment node
/**
 * excelToFortune on workbook features the round-trip suite does not build:
 * colour-scale and data-bar conditional formats, shared formulas, an auto
 * filter set as a from/to range, and sheets larger than Fortune Sheet's
 * default 50×26 grid. Runs in node for the same reason as the round-trip
 * suite: JSZip rejects ArrayBuffers from the jsdom realm.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { excelToFortune } from "@/lib/excelImport";

async function bytes(wb: ExcelJS.Workbook): Promise<ArrayBuffer> {
  const buf = (await wb.xlsx.writeBuffer()) as Buffer;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function cellAt(sheet: { celldata: Array<{ r: number; c: number; v: unknown }> }, r: number, c: number) {
  return sheet.celldata.find((cell) => cell.r === r && cell.c === c)?.v as Record<string, unknown> | undefined;
}

describe("excelToFortune formats", () => {
  it("maps colour scales and data bars to Fortune colours", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Scores");
    for (let row = 1; row <= 4; row += 1) ws.getCell(row, 1).value = row * 10;
    ws.addConditionalFormatting({
      ref: "A1:A4",
      rules: [
        {
          type: "colorScale",
          priority: 1,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: [{ argb: "FFFF0000" }, { argb: "FF00FF00" }],
        },
        {
          type: "dataBar",
          priority: 2,
          cfvo: [{ type: "min" }, { type: "max" }],
          color: { argb: "FF0000FF" },
        },
      ] as never,
    });

    const [sheet] = await excelToFortune(await bytes(wb));
    const byType = Object.fromEntries((sheet.conditions ?? []).map((c: any) => [c.type, c]));

    expect(byType.colorScale).toMatchObject({ ref: "A1:A4", color: ["#FF0000", "#00FF00"] });
    expect(byType.colorScale.cfvo).toHaveLength(2);
    expect(byType.dataBar).toMatchObject({ ref: "A1:A4", priority: 2 });
  });

  it("keeps shared formulas with their cached result", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sums");
    ws.getCell("A1").value = 1;
    ws.getCell("A2").value = 2;
    ws.getCell("B1").value = { formula: "A1*2", result: 2, shareType: "shared", ref: "B1:B2" } as ExcelJS.CellValue;
    ws.getCell("B2").value = { sharedFormula: "B1", result: 4 } as ExcelJS.CellValue;

    const [sheet] = await excelToFortune(await bytes(wb));

    expect(cellAt(sheet, 0, 1)).toMatchObject({ f: "A1*2", v: 2, m: "2" });
    const shared = cellAt(sheet, 1, 1)!;
    expect(shared.v).toBe(4);
    expect(shared.m).toBe("4");
    expect(typeof shared.f).toBe("string");
  });

  it("reads an auto filter the workbook set as a from/to range", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Filtered");
    ws.getCell("B2").value = "x";
    ws.autoFilter = { from: { row: 2, column: 2 }, to: { row: 9, column: 4 } };

    const [sheet] = await excelToFortune(await bytes(wb));

    expect(sheet.filter_select).toEqual({ row: [1, 8], column: [1, 3] });
  });

  it("grows the grid to fit cells and columns beyond the default size", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Wide");
    ws.getCell(80, 3).value = "deep";
    ws.getColumn(40).width = 12;

    const [sheet] = await excelToFortune(await bytes(wb));

    expect(sheet.row).toBeGreaterThanOrEqual(80);
    expect(sheet.column).toBeGreaterThanOrEqual(40);
  });
});
