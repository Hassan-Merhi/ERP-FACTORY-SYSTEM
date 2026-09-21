/**
 * tests/excel-helper.test.ts
 * ---------------------------
 * Regression tests for client/src/lib/excelHelper.ts — the ExcelJS-backed
 * compatibility layer that replaced the raw xlsx (SheetJS) package on the
 * client side.
 *
 * Goal: verify that every exported utility behaves identically to the SheetJS
 * API it mirrors, so any future refactors can be caught by these tests.
 *
 * Browser-only functions (writeFile, readFile) are not tested here because
 * they use document.createElement / URL.createObjectURL which are unavailable
 * in Node.  They are covered implicitly by the round-trip tests that use
 * workbook.xlsx.writeBuffer() ↔ readFromBuffer().
 */

import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { utils, readFromBuffer, read, type ExcelRange } from "../client/src/lib/excelHelper";

// ── shared fixture ─────────────────────────────────────────────────────────────

/** Build a Buffer from an ExcelJS workbook (no browser APIs). */
async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const raw = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}

// ── utils.book_new ─────────────────────────────────────────────────────────────

describe("utils.book_new()", () => {
  it("returns an ExcelJS.Workbook instance", () => {
    const wb = utils.book_new();
    expect(wb).toBeInstanceOf(ExcelJS.Workbook);
  });

  it("starts with zero worksheets", () => {
    const wb = utils.book_new();
    expect(wb.worksheets.length).toBe(0);
  });
});

// ── utils.encode_col ──────────────────────────────────────────────────────────

describe("utils.encode_col()", () => {
  const cases: [number, string][] = [
    [0, "A"],
    [1, "B"],
    [25, "Z"],
    [26, "AA"],
    [27, "AB"],
    [51, "AZ"],
    [52, "BA"],
  ];

  for (const [col, expected] of cases) {
    it(`encode_col(${col}) → "${expected}"`, () => {
      expect(utils.encode_col(col)).toBe(expected);
    });
  }
});

// ── utils.encode_cell ─────────────────────────────────────────────────────────

describe("utils.encode_cell()", () => {
  it("{r:0, c:0} → 'A1'", () => {
    expect(utils.encode_cell({ r: 0, c: 0 })).toBe("A1");
  });

  it("{r:4, c:5} → 'F5'", () => {
    expect(utils.encode_cell({ r: 4, c: 5 })).toBe("F5");
  });

  it("{r:9, c:25} → 'Z10'", () => {
    expect(utils.encode_cell({ r: 9, c: 25 })).toBe("Z10");
  });

  it("{r:0, c:26} → 'AA1'", () => {
    expect(utils.encode_cell({ r: 0, c: 26 })).toBe("AA1");
  });
});

// ── utils.encode_range / decode_range ─────────────────────────────────────────

describe("utils.encode_range()", () => {
  it("A1:B2 for {s:{r:0,c:0}, e:{r:1,c:1}}", () => {
    const range: ExcelRange = { s: { r: 0, c: 0 }, e: { r: 1, c: 1 } };
    expect(utils.encode_range(range)).toBe("A1:B2");
  });

  it("handles multi-letter columns: AA1:AZ10", () => {
    const range: ExcelRange = { s: { r: 0, c: 26 }, e: { r: 9, c: 51 } };
    expect(utils.encode_range(range)).toBe("AA1:AZ10");
  });
});

describe("utils.decode_range()", () => {
  it("'A1:B2' → {s:{r:0,c:0}, e:{r:1,c:1}}", () => {
    const r = utils.decode_range("A1:B2");
    expect(r.s).toEqual({ r: 0, c: 0 });
    expect(r.e).toEqual({ r: 1, c: 1 });
  });

  it("'AA2:AZ10' → correct multi-letter column values", () => {
    const r = utils.decode_range("AA2:AZ10");
    expect(r.s.c).toBe(26); // AA = col 26 (0-indexed)
    expect(r.e.c).toBe(51); // AZ = col 51
    expect(r.s.r).toBe(1);  // row 2 → index 1
    expect(r.e.r).toBe(9);  // row 10 → index 9
  });

  it("returns {s:{r:0,c:0}, e:{r:0,c:0}} for invalid input", () => {
    const r = utils.decode_range("NOTVALID");
    expect(r.s).toEqual({ r: 0, c: 0 });
    expect(r.e).toEqual({ r: 0, c: 0 });
  });
});

describe("encode_range ↔ decode_range round-trip", () => {
  it("is lossless for arbitrary ranges", () => {
    const orig: ExcelRange = { s: { r: 2, c: 3 }, e: { r: 10, c: 25 } };
    expect(utils.decode_range(utils.encode_range(orig))).toEqual(orig);
  });
});

// ── utils.json_to_sheet ───────────────────────────────────────────────────────

describe("utils.json_to_sheet()", () => {
  it("extracts headers from first object's keys", () => {
    const data = [{ Name: "Alice", Age: 30 }, { Name: "Bob", Age: 25 }];
    const sheet = utils.json_to_sheet(data);
    expect(sheet.headers).toEqual(["Name", "Age"]);
    expect(sheet.data).toEqual(data);
  });

  it("respects explicit header order from options.header", () => {
    const data = [{ Name: "Alice", Age: 30 }];
    const sheet = utils.json_to_sheet(data, { header: ["Age", "Name"] });
    expect(sheet.headers).toEqual(["Age", "Name"]);
  });

  it("returns empty data + headers for empty array", () => {
    const sheet = utils.json_to_sheet([]);
    expect(sheet.data).toEqual([]);
    expect(sheet.headers).toEqual([]);
  });

  it("preserves explicit header even when data is empty", () => {
    const sheet = utils.json_to_sheet([], { header: ["X", "Y"] });
    expect(sheet.headers).toEqual(["X", "Y"]);
    expect(sheet.data).toEqual([]);
  });
});

// ── utils.aoa_to_sheet ────────────────────────────────────────────────────────

describe("utils.aoa_to_sheet()", () => {
  it("wraps array-of-arrays into { aoa: [...] }", () => {
    const data = [["A", "B"], [1, 2], [3, 4]];
    const sheet = utils.aoa_to_sheet(data);
    expect(sheet.aoa).toEqual(data);
  });

  it("handles null gracefully → { aoa: [] }", () => {
    const sheet = utils.aoa_to_sheet(null as any);
    expect(sheet.aoa).toEqual([]);
  });

  it("handles empty array → { aoa: [] }", () => {
    const sheet = utils.aoa_to_sheet([]);
    expect(sheet.aoa).toEqual([]);
  });
});

// ── utils.sheet_add_aoa ───────────────────────────────────────────────────────

describe("utils.sheet_add_aoa()", () => {
  it("default origin (0,0) overwrites row 0", () => {
    const sheet = utils.aoa_to_sheet([["old"]]);
    utils.sheet_add_aoa(sheet, [["new"]], {});
    expect(sheet.aoa[0][0]).toBe("new");
  });

  it("string origin 'A3' places rows starting at index 2", () => {
    const sheet = utils.aoa_to_sheet([]);
    utils.sheet_add_aoa(sheet, [["v1", "v2"]], { origin: "A3" });
    expect(sheet.aoa[2]).toEqual(["v1", "v2"]);
  });

  it("string origin 'B2' places value at row 1, col 1", () => {
    const sheet = utils.aoa_to_sheet([]);
    utils.sheet_add_aoa(sheet, [["x"]], { origin: "B2" });
    expect(sheet.aoa[1][1]).toBe("x");
  });

  it("object origin { r:1, c:2 } places value at correct index", () => {
    const sheet = utils.aoa_to_sheet([]);
    utils.sheet_add_aoa(sheet, [["cell"]], { origin: { r: 1, c: 2 } });
    expect(sheet.aoa[1][2]).toBe("cell");
  });

  it("preserves existing rows outside the write area", () => {
    const sheet = utils.aoa_to_sheet([["header1", "header2"]]);
    utils.sheet_add_aoa(sheet, [["data1", "data2"]], { origin: "A2" });
    expect(sheet.aoa[0]).toEqual(["header1", "header2"]);
    expect(sheet.aoa[1]).toEqual(["data1", "data2"]);
  });

  it("writing multiple rows extends aoa correctly", () => {
    const sheet = utils.aoa_to_sheet([]);
    utils.sheet_add_aoa(sheet, [["r1"], ["r2"], ["r3"]], { origin: "A1" });
    expect(sheet.aoa.length).toBeGreaterThanOrEqual(3);
    expect(sheet.aoa[0][0]).toBe("r1");
    expect(sheet.aoa[2][0]).toBe("r3");
  });
});

// ── utils.book_append_sheet ───────────────────────────────────────────────────

describe("utils.book_append_sheet()", () => {
  it("creates a worksheet with the specified name", () => {
    const wb = utils.book_new();
    const sheet = utils.json_to_sheet([{ A: 1 }]);
    utils.book_append_sheet(wb, sheet, "MySheet");
    expect(wb.getWorksheet("MySheet")).toBeDefined();
  });

  it("appends an AOA sheet with correct cell values", () => {
    const wb = utils.book_new();
    const sheet = utils.aoa_to_sheet([["X", "Y"], [1, 2], [3, 4]]);
    utils.book_append_sheet(wb, sheet, "AoaSheet");
    const ws = wb.getWorksheet("AoaSheet")!;
    expect(ws.getRow(1).getCell(1).value).toBe("X");
    expect(ws.getRow(1).getCell(2).value).toBe("Y");
    expect(ws.getRow(2).getCell(1).value).toBe(1);
    expect(ws.getRow(3).getCell(2).value).toBe(4);
  });

  it("appends a json_to_sheet with header row first, then data", () => {
    const wb = utils.book_new();
    const data = [{ Name: "Alice", Score: 95 }, { Name: "Bob", Score: 80 }];
    const sheet = utils.json_to_sheet(data);
    utils.book_append_sheet(wb, sheet, "Json");
    const ws = wb.getWorksheet("Json")!;
    // Row 1 = headers
    expect(ws.getRow(1).getCell(1).value).toBe("Name");
    expect(ws.getRow(1).getCell(2).value).toBe("Score");
    // Row 2 = Alice
    expect(ws.getRow(2).getCell(1).value).toBe("Alice");
    expect(ws.getRow(2).getCell(2).value).toBe(95);
    // Row 3 = Bob
    expect(ws.getRow(3).getCell(1).value).toBe("Bob");
    expect(ws.getRow(3).getCell(2).value).toBe(80);
  });

  it("applies !cols column widths", () => {
    const wb = utils.book_new();
    const sheet = utils.aoa_to_sheet([["A"]]);
    sheet["!cols"] = [{ wch: 20 }, { wch: 35 }];
    utils.book_append_sheet(wb, sheet, "Widths");
    const ws = wb.getWorksheet("Widths")!;
    expect(ws.getColumn(1).width).toBe(20);
    expect(ws.getColumn(2).width).toBe(35);
  });

  it("applies !freeze pane", () => {
    const wb = utils.book_new();
    const sheet = utils.aoa_to_sheet([["H"]]);
    sheet["!freeze"] = { xSplit: 1, ySplit: 2 };
    utils.book_append_sheet(wb, sheet, "Freeze");
    const ws = wb.getWorksheet("Freeze")!;
    const view = (ws.views[0] ?? {}) as any;
    expect(view.state).toBe("frozen");
    expect(view.xSplit).toBe(1);
    expect(view.ySplit).toBe(2);
  });

  it("missing fields in json data are filled with empty string", () => {
    const wb = utils.book_new();
    // data row missing "Score"
    const data = [{ Name: "Alice", Score: 90 }, { Name: "Bob" }];
    const sheet = utils.json_to_sheet(data);
    utils.book_append_sheet(wb, sheet, "Missing");
    const ws = wb.getWorksheet("Missing")!;
    // Bob's Score cell should be empty string (not undefined)
    expect(ws.getRow(3).getCell(2).value).toBe("");
  });
});

// ── utils.sheet_to_json ───────────────────────────────────────────────────────

describe("utils.sheet_to_json() — default (header-row mode)", () => {
  let ws: ExcelJS.Worksheet;

  beforeAll(() => {
    const wb = new ExcelJS.Workbook();
    ws = wb.addWorksheet("Test");
    ws.addRow(["Name", "Age", "City"]);
    ws.addRow(["Alice", 30, "Paris"]);
    ws.addRow(["Bob", 25, "Berlin"]);
  });

  it("returns one object per data row keyed by header", () => {
    const rows = utils.sheet_to_json(ws) as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].Name).toBe("Alice");
    expect(rows[0].Age).toBe(30);
    expect(rows[0].City).toBe("Paris");
  });

  it("applies defval for truly absent cells (short row that doesn't reach the column)", () => {
    // The row only has 2 cells; header C has no cell at all → defval is applied.
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet("Def");
    ws2.addRow(["A", "B", "C"]);
    ws2.addRow(["x", "y"]); // C is absent (not null, just not present)
    const rows = utils.sheet_to_json(ws2, { defval: "" }) as any[];
    expect(rows[0].A).toBe("x");
    expect(rows[0].B).toBe("y");
    expect(rows[0].C).toBe(""); // absent → defval
  });

  it("null cells are stored as null — defval does NOT override explicit null", () => {
    // eachCell({includeEmpty:true}) visits null cells and sets rowData[key]=null;
    // defval only applies when key is completely absent (undefined).
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet("Null");
    ws2.addRow(["A", "B", "C"]);
    ws2.addRow(["x", null, "z"]);
    const rows = utils.sheet_to_json(ws2, { defval: "" }) as any[];
    expect(rows[0].A).toBe("x");
    expect(rows[0].B).toBeNull(); // explicit null — defval NOT applied
    expect(rows[0].C).toBe("z");
  });

  it("applies null defval for absent cells", () => {
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet("D");
    ws2.addRow(["X", "Y"]);
    ws2.addRow(["val"]); // Y absent
    const rows = utils.sheet_to_json(ws2, { defval: null }) as any[];
    expect(rows[0].Y).toBeNull();
  });

  it("unwraps formula result objects", () => {
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet("F");
    ws2.addRow(["Val"]);
    (ws2.getRow(2).getCell(1) as any).value = { formula: "=1+1", result: 2 };
    const rows = utils.sheet_to_json(ws2) as any[];
    expect(rows[0].Val).toBe(2);
  });

  it("unwraps rich-text objects to their plain text", () => {
    const wb2 = new ExcelJS.Workbook();
    const ws2 = wb2.addWorksheet("RT");
    ws2.addRow(["Label"]);
    (ws2.getRow(2).getCell(1) as any).value = { text: "Hello" };
    const rows = utils.sheet_to_json(ws2) as any[];
    expect(rows[0].Label).toBe("Hello");
  });
});

describe("utils.sheet_to_json() — header: 1 (AOA mode)", () => {
  it("includes the header row as row 0, data starts at row 1", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("AOA");
    ws.addRow(["Name", "Age"]);
    ws.addRow(["Alice", 30]);
    ws.addRow(["Bob", 25]);
    const rows = utils.sheet_to_json(ws, { header: 1 }) as any[][];
    expect(rows[0]).toEqual(["Name", "Age"]);
    expect(rows[1][0]).toBe("Alice");
    expect(rows[2][1]).toBe(25);
  });

  it("returns all rows including header in AOA mode", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("AOA2");
    ws.addRow(["H1", "H2"]);
    ws.addRow([1, 2]);
    const rows = utils.sheet_to_json(ws, { header: 1 }) as any[][];
    expect(rows.length).toBe(2);
  });
});

// ── readFromBuffer ────────────────────────────────────────────────────────────

describe("readFromBuffer()", () => {
  it("loads a workbook from an ArrayBuffer", async () => {
    const src = new ExcelJS.Workbook();
    src.addWorksheet("Sheet1");
    const buf = await toBuffer(src);
    const wb = await readFromBuffer(buf.buffer as ArrayBuffer);
    expect(wb.getWorksheet("Sheet1")).toBeDefined();
  });

  it("reads the correct cell values after a round-trip", async () => {
    const src = new ExcelJS.Workbook();
    const ws = src.addWorksheet("Data");
    ws.addRow(["key", "value"]);
    ws.addRow(["foo", "bar"]);
    const buf = await toBuffer(src);
    const wb = await readFromBuffer(buf.buffer as ArrayBuffer);
    const ws2 = wb.getWorksheet("Data")!;
    expect(ws2.getRow(2).getCell(1).value).toBe("foo");
    expect(ws2.getRow(2).getCell(2).value).toBe("bar");
  });

  it("accepts a Uint8Array input", async () => {
    const src = new ExcelJS.Workbook();
    src.addWorksheet("X");
    const buf = await toBuffer(src);
    const wb = await readFromBuffer(new Uint8Array(buf));
    expect(wb.getWorksheet("X")).toBeDefined();
  });
});

// ── read() ────────────────────────────────────────────────────────────────────

describe("read()", () => {
  it("populates SheetNames and Sheets from the buffer", async () => {
    const src = new ExcelJS.Workbook();
    src.addWorksheet("ReadMe");
    src.addWorksheet("Other");
    const buf = await toBuffer(src);
    const { SheetNames, Sheets } = await read(buf.buffer as ArrayBuffer);
    expect(SheetNames).toContain("ReadMe");
    expect(SheetNames).toContain("Other");
    expect(Sheets["ReadMe"]).toBeDefined();
  });

  it("SheetNames and Sheets keys match exactly", async () => {
    const src = new ExcelJS.Workbook();
    src.addWorksheet("Alpha");
    src.addWorksheet("Beta");
    const buf = await toBuffer(src);
    const { SheetNames, Sheets } = await read(buf.buffer as ArrayBuffer);
    expect(SheetNames).toEqual(["Alpha", "Beta"]);
    expect(Object.keys(Sheets).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("ignores trailing pooled bytes that resemble a corrupt ZIP directory", async () => {
    const src = new ExcelJS.Workbook();
    src.addWorksheet("Pooled");
    const buf = await toBuffer(src);
    const exact = new Uint8Array(buf);
    const pooled = new Uint8Array(exact.length + 64);
    pooled.set(exact);

    // Simulate unrelated bytes after a Buffer slice in a shared backing
    // ArrayBuffer. The fake EOCD advertises an impossible directory offset;
    // JSZip must never see it when the real XLSX payload is extracted first.
    const fakeEocd = exact.length + 16;
    pooled.set([0x50, 0x4b, 0x05, 0x06], fakeEocd);
    pooled.fill(0xff, fakeEocd + 16, fakeEocd + 20);

    const { SheetNames } = await read(pooled.buffer);
    expect(SheetNames).toEqual(["Pooled"]);
  });

  it("also accepts Uint8Array", async () => {
    const src = new ExcelJS.Workbook();
    src.addWorksheet("U8");
    const buf = await toBuffer(src);
    const { SheetNames } = await read(new Uint8Array(buf));
    expect(SheetNames).toContain("U8");
  });

  it("recovers the newest complete workbook from a pooled ArrayBuffer", async () => {
    const stale = new ExcelJS.Workbook();
    stale.addWorksheet("Stale");
    const current = new ExcelJS.Workbook();
    current.addWorksheet("Current");

    const staleBuffer = await toBuffer(stale);
    const currentBuffer = await toBuffer(current);
    const currentOffset = 11 + staleBuffer.length + 13;
    const slab = new Uint8Array(currentOffset + currentBuffer.length + 17);

    slab.set(staleBuffer, 11);
    slab.set(currentBuffer, currentOffset);

    const { SheetNames } = await read(slab.buffer);
    expect(SheetNames).toEqual(["Current"]);
  });

  it("throws for null with message 'no data provided'", async () => {
    await expect(read(null)).rejects.toThrow("no data provided");
  });

  it("throws for undefined with message 'no data provided'", async () => {
    await expect(read(undefined)).rejects.toThrow("no data provided");
  });
});

// ── full round-trip: utils → buffer → read ────────────────────────────────────

describe("Full round-trip (utils → writeBuffer → read → sheet_to_json)", () => {
  it("json_to_sheet → book_append_sheet → buffer → read → sheet_to_json", async () => {
    const wb = utils.book_new();
    const data = [{ Product: "Widget", Price: 9.99, Qty: 100 }];
    const sheet = utils.json_to_sheet(data);
    utils.book_append_sheet(wb, sheet, "Products");
    const raw = await wb.xlsx.writeBuffer();
    const { Sheets } = await read(Buffer.from(raw).buffer as ArrayBuffer);
    const rows = utils.sheet_to_json(Sheets["Products"]) as any[];
    expect(rows[0].Product).toBe("Widget");
    expect(rows[0].Price).toBe(9.99);
    expect(rows[0].Qty).toBe(100);
  });

  it("aoa_to_sheet → book_append_sheet → buffer → readFromBuffer", async () => {
    const wb = utils.book_new();
    const sheet = utils.aoa_to_sheet([["H1", "H2"], [1, 2], [3, 4]]);
    utils.book_append_sheet(wb, sheet, "AOA");
    const raw = await wb.xlsx.writeBuffer();
    const loaded = await readFromBuffer(Buffer.from(raw).buffer as ArrayBuffer);
    const ws = loaded.getWorksheet("AOA")!;
    expect(ws.getRow(1).getCell(1).value).toBe("H1");
    expect(ws.getRow(3).getCell(2).value).toBe(4);
  });

  it("multiple sheets survive the round-trip", async () => {
    const wb = utils.book_new();
    utils.book_append_sheet(wb, utils.json_to_sheet([{ Col: "S1" }]), "S1");
    utils.book_append_sheet(wb, utils.json_to_sheet([{ Col: "S2" }]), "S2");
    const raw = await wb.xlsx.writeBuffer();
    const { SheetNames, Sheets } = await read(Buffer.from(raw).buffer as ArrayBuffer);
    expect(SheetNames).toContain("S1");
    expect(SheetNames).toContain("S2");
    const rows = utils.sheet_to_json(Sheets["S2"]) as any[];
    expect(rows[0].Col).toBe("S2");
  });

  it("formula object result is preserved after write → readFromBuffer", async () => {
    const src = new ExcelJS.Workbook();
    const ws = src.addWorksheet("Formulas");
    ws.addRow(["Value"]);
    (ws.getRow(2).getCell(1) as any).value = { formula: "=2*3", result: 6 };
    const buf = await toBuffer(src);
    const loaded = await readFromBuffer(buf.buffer as ArrayBuffer);
    const ws2 = loaded.getWorksheet("Formulas")!;
    const cell = ws2.getRow(2).getCell(1).value as any;
    // ExcelJS stores formula with cached result; sheet_to_json extracts the result
    expect(cell?.result ?? cell).toBe(6);
  });

  it("sheet_add_aoa then book_append_sheet preserves all rows", async () => {
    const wb = utils.book_new();
    const sheet = utils.aoa_to_sheet([["A", "B"]]);
    utils.sheet_add_aoa(sheet, [["r1c1", "r1c2"]], { origin: "A2" });
    utils.sheet_add_aoa(sheet, [["r2c1", "r2c2"]], { origin: "A3" });
    utils.book_append_sheet(wb, sheet, "Parts");
    const ws = wb.getWorksheet("Parts")!;
    expect(ws.getRow(1).getCell(1).value).toBe("A");
    expect(ws.getRow(2).getCell(1).value).toBe("r1c1");
    expect(ws.getRow(3).getCell(2).value).toBe("r2c2");
  });
});
