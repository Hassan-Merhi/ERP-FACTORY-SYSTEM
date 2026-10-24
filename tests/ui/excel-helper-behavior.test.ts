/**
 * excelHelper.ts is the XLSX/CSV layer behind every import and export: it
 * builds sheets, reads uploads (XLSX, CSV, binary strings, File objects),
 * recovers a workbook from a Node Buffer's backing slab, and rewrites a
 * "Container Items" export so its lines are sorted and totalled. Each case
 * round-trips through real ExcelJS.
 */
import ExcelJS from "exceljs";
import { read, readFile, readFromBuffer, utils } from "@/lib/excelHelper";

async function xlsxBytes(build: (workbook: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const workbook = utils.book_new();
  build(workbook);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

function csvBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function rows(worksheet: ExcelJS.Worksheet): unknown[][] {
  return utils.sheet_to_json<unknown[]>(worksheet, { header: 1 }).map((row) => [...row]);
}

describe("building sheets", () => {
  it("places rows at a cell origin, an object origin or the top-left by default", () => {
    const sheet = utils.aoa_to_sheet([["Title"]]);
    utils.sheet_add_aoa(sheet, [["a", "b"]], { origin: "B3" });
    utils.sheet_add_aoa(sheet, [["c"]], { origin: { r: 1, c: 0 } });
    utils.sheet_add_aoa(sheet, [["top"]]);
    utils.sheet_add_aoa(sheet, [["fallback"]], { origin: "not-a-cell" });

    expect(sheet.aoa[0]).toEqual(["fallback"]);
    expect(sheet.aoa[1]).toEqual(["c"]);
    expect(sheet.aoa[2]).toEqual([undefined, "a", "b"]);
  });

  it("starts an array sheet that has none", () => {
    const sheet = utils.sheet_add_aoa({} as never, [["x"]]);
    expect(sheet.aoa).toEqual([["x"]]);
  });

  it("keeps column widths and frozen panes through a round trip", async () => {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = {
        ...utils.aoa_to_sheet([
          ["Code", "Name"],
          ["A1", "Alpha"],
        ]),
      };
      Object.assign(sheet, { "!cols": [{ wch: 12 }, { wch: 30 }], "!freeze": { ySplit: 1 } });
      utils.book_append_sheet(workbook, sheet, "Items");
    });

    const { Sheets } = await read(bytes);

    expect(Sheets.Items.getColumn(1).width).toBe(12);
    expect(Sheets.Items.getColumn(2).width).toBe(30);
    expect(Sheets.Items.views[0]).toMatchObject({ state: "frozen", xSplit: 0, ySplit: 1 });
  });

  it("writes a JSON sheet with its header row and blanks for missing values", async () => {
    const bytes = await xlsxBytes((workbook) => {
      utils.book_append_sheet(
        workbook,
        utils.json_to_sheet([{ code: "A1", qty: 3 }, { code: "B2" }], { header: ["code", "qty"] }),
        "Stock"
      );
    });

    const { Sheets } = await read(bytes);

    expect(rows(Sheets.Stock)).toEqual([
      ["code", "qty"],
      ["A1", 3],
      ["B2", ""],
    ]);
    expect(utils.json_to_sheet([], { header: ["only"] })).toEqual({ data: [], headers: ["only"] });
  });
});

describe("reading sheets", () => {
  async function formulaAndRichTextSheet(): Promise<ExcelJS.Worksheet> {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet("Values");
      sheet.addRow(["Item", "Total", "Note", ""]);
      sheet.addRow(["Shirts", { formula: "2+3", result: 5 }, { richText: [{ text: "rush" }] }, "ignored"]);
      sheet.addRow(["Pants"]);
    });
    return (await read(bytes)).Sheets.Values;
  }

  it("reads header rows as objects, unwrapping formula results and rich text", async () => {
    const sheet = await formulaAndRichTextSheet();

    expect(utils.sheet_to_json(sheet)).toEqual([{ Item: "Shirts", Total: 5, Note: "rush" }, { Item: "Pants" }]);
  });

  it("fills missing cells with defval when one is given", async () => {
    const sheet = await formulaAndRichTextSheet();

    expect(utils.sheet_to_json(sheet, { defval: null })[1]).toEqual({ Item: "Pants", Total: null, Note: null });
  });

  it("reads raw rows with header: 1, unwrapping the same values and skipping blank rows", async () => {
    const sheet = await formulaAndRichTextSheet();

    expect(rows(sheet)[1]).toEqual(["Shirts", 5, "rush", "ignored"]);
  });
});

describe("reading uploads", () => {
  it("reads a CSV, stripping a byte-order mark and skipping blank lines", async () => {
    const { SheetNames, Sheets } = await read(csvBytes("﻿code,qty\nA1,3\n\n\nB2,4\n"));

    expect(SheetNames).toEqual(["Sheet1"]);
    expect(rows(Sheets.Sheet1)).toEqual([
      ["code", "qty"],
      ["A1", "3"],
      ["B2", "4"],
    ]);
  });

  it.each([
    ["no bytes at all", ""],
    ["only blank lines", "\n\n\r\n"],
    ["only a byte-order mark and spaces", "\uFEFF   "],
  ])("reports a CSV with %s as empty", async (_label, text) => {
    await expect(read(csvBytes(text))).rejects.toThrow("CSV file is empty");
  });

  it("rejects a malformed CSV with the parser's reason", async () => {
    await expect(read(csvBytes('code,name\n"A1,unterminated'))).rejects.toThrow(/Could not parse CSV/);
  });

  it("reads a workbook given as a binary string and as a File", async () => {
    const bytes = await xlsxBytes((workbook) => workbook.addWorksheet("Only").addRow(["ok"]));
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

    expect((await read(binary)).SheetNames).toEqual(["Only"]);
    expect((await read(new File([bytes], "upload.xlsx"))).SheetNames).toEqual(["Only"]);
    expect((await readFile(new File([bytes], "upload.xlsx"))).getWorksheet("Only")).toBeDefined();
  });

  it("refuses missing and unsupported input", async () => {
    await expect(read(null)).rejects.toThrow("no data provided");
    await expect(read(42 as never)).rejects.toThrow("unsupported data type");
  });

  it("recovers the newest complete workbook from a Buffer's backing slab", async () => {
    const older = await xlsxBytes((workbook) => workbook.addWorksheet("Old").addRow(["old"]));
    const newer = await xlsxBytes((workbook) => workbook.addWorksheet("New").addRow(["new"]));
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const slab = new Uint8Array(junk.length + older.length + newer.length + junk.length);
    slab.set(junk, 0);
    slab.set(older, junk.length);
    slab.set(newer, junk.length + older.length);
    slab.set(junk, junk.length + older.length + newer.length);

    const workbook = await readFromBuffer(slab.buffer);

    expect(workbook.getWorksheet("New")).toBeDefined();
    expect(workbook.getWorksheet("Old")).toBeUndefined();
  });

  it("uses a Uint8Array that already is a workbook as-is", async () => {
    const bytes = await xlsxBytes((workbook) => workbook.addWorksheet("Direct").addRow(["ok"]));

    expect((await readFromBuffer(bytes)).getWorksheet("Direct")).toBeDefined();
  });
});

describe("Container Items exports", () => {
  async function exportContainerItems(lines: unknown[][], withTotal: boolean) {
    const bytes = await xlsxBytes((workbook) => {
      const sheet = workbook.addWorksheet("Container Items");
      sheet.addRow(["Container MSKU1234567"]);
      sheet.addRow([]);
      sheet.addRow(["NO", "BARCODE", "DESCRIPTION", "Q'TY"]);
      for (const line of lines) sheet.addRow(line);
      if (withTotal) sheet.addRow(["TOTAL Q'TY", "", "", 0]);
    });
    return (await read(bytes)).Sheets["Container Items"];
  }

  it("sorts the lines by description, renumbers them and adds a SUM total", async () => {
    const sheet = await exportContainerItems(
      [
        [1, "B-3", "Shirts 10", 4],
        [2, "B-1", "jackets", 2],
        [3, "B-2", "Shirts 9", 5],
      ],
      false
    );

    const line = (row: number) => [1, 2, 3, 4].map((column) => sheet.getRow(row).getCell(column).value);
    expect([line(4), line(5), line(6)]).toEqual([
      [1, "B-1", "jackets", 2],
      [2, "B-2", "Shirts 9", 5],
      [3, "B-3", "Shirts 10", 4],
    ]);
    expect(sheet.getCell("A7").value).toBe("TOTAL Q'TY");
    expect(sheet.getCell("D7").value).toMatchObject({ formula: "SUM(D4:D6)" });
    expect(sheet.pageSetup.printArea).toBe("A1:D7");
  });

  it("reuses an existing total row instead of adding a second one", async () => {
    const sheet = await exportContainerItems(
      [
        [1, "B-2", "Pants", 1],
        [2, "B-1", "Belts", 3],
      ],
      true
    );

    expect(sheet.getCell("C4").value).toBe("Belts");
    expect(sheet.getCell("A6").value).toBe("TOTAL Q'TY");
    expect(sheet.getCell("D6").value).toMatchObject({ formula: "SUM(D4:D5)" });
    expect(sheet.rowCount).toBe(6);
  });

  it("totals an empty export as zero", async () => {
    const sheet = await exportContainerItems([], false);

    expect(sheet.getCell("A4").value).toBe("TOTAL Q'TY");
    expect(sheet.getCell("D4").value).toBe(0);
  });

  it("leaves other sheets and differently laid out Container Items sheets untouched", async () => {
    const bytes = await xlsxBytes((workbook) => {
      const other = workbook.addWorksheet("Container Items");
      other.addRow(["Different layout"]);
      other.addRow([]);
      other.addRow(["Code", "Name"]);
      other.addRow(["Z", "zeta"]);
      other.addRow(["A", "alpha"]);
    });

    const sheet = (await read(bytes)).Sheets["Container Items"];

    expect(sheet.getCell("A4").value).toBe("Z");
    expect(sheet.getCell("A5").value).toBe("A");
    expect(sheet.rowCount).toBe(5);
  });
});

describe("cell addressing", () => {
  it.each([
    [0, "A"],
    [25, "Z"],
    [26, "AA"],
    [701, "ZZ"],
    [702, "AAA"],
  ])("column %i is %s", (column, letters) => {
    expect(utils.encode_col(column)).toBe(letters);
  });

  it("encodes and decodes ranges and cells", () => {
    const range = { s: { r: 0, c: 0 }, e: { r: 9, c: 27 } };

    expect(utils.encode_range(range)).toBe("A1:AB10");
    expect(utils.decode_range("A1:AB10")).toEqual(range);
    expect(utils.decode_range("nonsense")).toEqual({ s: { r: 0, c: 0 }, e: { r: 0, c: 0 } });
    expect(utils.encode_cell({ r: 4, c: 2 })).toBe("C5");
  });
});
