import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  DEFAULT_UNIVERSAL_EXCEL_APPEARANCE,
  resolveUniversalExcelAppearance,
} from "../shared/universal-excel/design";
import {
  buildUniversalExcelWorkbook,
  type UniversalExcelWorkbookSpec,
} from "../shared/universal-excel/engine";

function report(
  overrides: Partial<UniversalExcelWorkbookSpec> = {},
): UniversalExcelWorkbookSpec {
  return {
    schemaVersion: 1,
    title: "Stock Summary",
    mode: "report",
    exportedAt: new Date(2026, 10, 13, 10),
    companyName: "HMD Factory",
    currencyCode: "USD",
    dateFormat: "dd/mm/yyyy",
    sheets: [{
      kind: "table",
      name: "Stock",
      columns: [
        { key: "code", header: "Article Code", type: "text" },
        { key: "qty", header: "Quantity", type: "integer" },
        { key: "amount", header: "Total Value", type: "money" },
      ],
      rows: [
        { code: "00012", qty: 2, amount: 5.5 },
        { code: "00013", qty: 1, amount: 3 },
        { code: "00014", qty: 3, amount: 7.5 },
      ],
      footer: { code: "TOTAL", qty: 6, amount: 16 },
    }],
    ...overrides,
  };
}

async function reread(spec: UniversalExcelWorkbookSpec): Promise<ExcelJS.Workbook> {
  const { workbook } = buildUniversalExcelWorkbook(spec);
  const raw = Buffer.from(await workbook.xlsx.writeBuffer());
  expect(raw.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(raw);
  return reopened;
}

describe("Phase 3: Dakzo appearance defaults and sanitization", () => {
  it("ships an accessible navy/white default and neutral slate preset", () => {
    expect(DEFAULT_UNIVERSAL_EXCEL_APPEARANCE.brandName).toBe("DAKZO SYSTEMS");
    const dakzo = resolveUniversalExcelAppearance();
    const slate = resolveUniversalExcelAppearance({ preset: "slate" });
    expect(dakzo.palette.primary).toBe("FF183153");
    expect(dakzo.palette.onPrimary).toBe("FFFFFFFF");
    expect(slate.palette.primary).toBe("FF334155");
    expect(slate.palette.onPrimary).toBe("FFFFFFFF");
  });

  it("validates accent colors and chooses readable dark text for pale colors", () => {
    const design = resolveUniversalExcelAppearance({ accentColor: "#FFFFFF" });
    expect(design.palette.primary).toBe("FFFFFFFF");
    expect(design.palette.onPrimary).toBe("FF172334");
    const dark = resolveUniversalExcelAppearance({ accentColor: "#101827" });
    expect(dark.palette.onPrimary).toBe("FFFFFFFF");
    expect(() => resolveUniversalExcelAppearance({ accentColor: "red" })).toThrow(/accent color/);
    expect(() => resolveUniversalExcelAppearance({ accentColor: "#ABCDEF00" })).toThrow(/accent color/);
    expect(() => resolveUniversalExcelAppearance({ preset: "wrong" as "slate" })).toThrow(/preset/);
    expect(() => resolveUniversalExcelAppearance({ brandName: "=Danger\n" })).toThrow(/brand name/);
  });

  it("renders Dakzo branding and native typed records without changing the Phase 2 header row", async () => {
    const workbook = await reread(report());
    const ws = workbook.getWorksheet("Stock")!;
    expect(ws.getCell("A1").value).toBe("Stock Summary");
    expect(ws.getCell("A4").value).toBe("DAKZO SYSTEMS");
    expect(ws.getCell("A5").value).toBe("Article Code");
    expect(ws.getCell("B5").value).toBe("Quantity");
    expect(ws.getCell("C5").value).toBe("Total Value");
    expect(ws.getCell("A6").value).toBe("00012");
    expect(ws.getCell("B6").value).toBe(2);
    expect(ws.getCell("C6").value).toBe(5.5);
    expect(ws.getCell("C6").numFmt).toBe("#,##0.00");
    expect(ws.getCell("A1").font).toMatchObject({ bold: true });
    expect(ws.getCell("A5").font).toMatchObject({ bold: true });
    expect(ws.getCell("A5").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FF183153" },
    });
  });

  it("adds full-row alternating fill only to detail rows and a distinct grand-total band", () => {
    const ws = buildUniversalExcelWorkbook(report()).workbook.getWorksheet("Stock")!;
    expect(ws.getCell("A7").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FFF4F7FB" },
    });
    expect(ws.getCell("C7").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FFF4F7FB" },
    });
    expect(ws.getCell("C9").value).toBe(16);
    expect(ws.getCell("C9").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FFDCE8F8" },
    });
    expect(ws.getCell("C9").font).toMatchObject({ bold: true });
  });

  it("styles group heading, subsection total and final total differently", () => {
    const spec = report({
      sheets: [{
        kind: "grouped",
        name: "Groups",
        columns: [
          { key: "article", header: "Article" },
          { key: "amount", header: "Total", type: "money" },
        ],
        groups: [{
          label: "Supplier A",
          rows: [{ article: "A", amount: 8 }, { article: "B", amount: 2 }],
          footer: { article: "Subtotal", amount: 10 },
        }],
        footer: { article: "Grand Total", amount: 10 },
      }],
    });
    const ws = buildUniversalExcelWorkbook(spec).workbook.getWorksheet("Groups")!;
    expect(ws.getCell("A6").value).toBe("Supplier A");
    expect(ws.getCell("A6").font).toMatchObject({ bold: true });
    expect(ws.getCell("B9").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FFEAF1FA" },
    });
    expect(ws.getCell("B10").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FFDCE8F8" },
    });
    expect(ws.getCell("B10").value).toBe(10);
  });

  it("sets printable A4 page layout, repeated headers, print area and page numbering", async () => {
    const wb = await reread(report());
    const ws = wb.getWorksheet("Stock")!;
    expect(ws.pageSetup.paperSize).toBe(9);
    expect(ws.pageSetup.orientation).toBe("portrait");
    expect(ws.pageSetup.fitToWidth).toBe(1);
    expect(ws.pageSetup.fitToHeight).toBe(0);
    expect(ws.pageSetup.printTitlesRow).toBe("1:5");
    expect(ws.pageSetup.printArea).toBe("A1:C9");
    expect(ws.headerFooter.oddHeader).toContain("DAKZO SYSTEMS");
    expect(ws.headerFooter.oddFooter).toContain("Page &P of &N");
  });

  it("switches to landscape for 9+ columns, with no changed data or headers", () => {
    const columns = Array.from({ length: 9 }, (_, n) => ({ key: "p" + n, header: "Col " + n }));
    const rows = [Object.fromEntries(columns.map(c => [c.key, "value"]))];
    const ws = buildUniversalExcelWorkbook(report({
      sheets: [{ kind: "table", name: "Wide", columns, rows }],
    })).workbook.getWorksheet("Wide")!;
    expect(ws.pageSetup.orientation).toBe("landscape");
    expect(ws.getCell("I5").value).toBe("Col 8");
    expect(ws.pageSetup.printArea).toBe("A1:I6");
  });

  it("supports alternate branding, disabled zebra rows and disabled print settings", () => {
    const ws = buildUniversalExcelWorkbook(report({
      appearance: {
        preset: "slate",
        brandName: "HMD International",
        accentColor: "#207040",
        alternateRows: false,
        printLayout: false,
      },
    })).workbook.getWorksheet("Stock")!;
    expect(ws.getCell("A4").value).toBe("HMD International");
    expect(ws.getCell("A5").fill).toMatchObject({
      type: "pattern", fgColor: { argb: "FF207040" },
    });
    const bodyFill = ws.getCell("A7").fill;
    expect(bodyFill && "pattern" in bodyFill && bodyFill.pattern === "solid").toBeFalsy();
    expect(ws.pageSetup.printArea).toBeUndefined();
  });

  it("can suppress visual branding without changing report rows", () => {
    const ws = buildUniversalExcelWorkbook(report({
      appearance: { showBranding: false },
    })).workbook.getWorksheet("Stock")!;
    expect(ws.getCell("A4").value).toBeNull();
    expect(ws.getCell("A1").value).toBe("Stock Summary");
    expect(ws.headerFooter.oddHeader).not.toContain("DAKZO SYSTEMS");
    expect(ws.getCell("C9").value).toBe(16);
  });

  it("removes injected Excel header/footer commands from printed title and brand text", () => {
    const ws = buildUniversalExcelWorkbook(report({
      title: "Loss &P and &N",
      appearance: { brandName: "ACME &P" },
    })).workbook.getWorksheet("Stock")!;
    expect(ws.headerFooter.oddHeader).toContain("ACME P");
    expect(ws.headerFooter.oddHeader).toContain("Loss P and N");
    expect(ws.headerFooter.oddHeader).not.toContain("ACME &P");
  });

  it("limits zebra styles on large exports while retaining all rows and totals", () => {
    const rows = Array.from({ length: 3001 }, (_, i) => ({
      code: "A" + i, qty: 1, amount: 1,
    }));
    const ws = buildUniversalExcelWorkbook(report({
      sheets: [{
        kind: "table",
        name: "Large",
        columns: [
          { key: "code", header: "Article Code" },
          { key: "qty", header: "Qty", type: "integer" },
          { key: "amount", header: "Amount", type: "money" },
        ],
        rows,
        footer: { code: "Total", qty: 3001, amount: 3001 },
      }],
    })).workbook.getWorksheet("Large")!;
    const largeBodyFill = ws.getCell("A7").fill;
    expect(largeBodyFill && "pattern" in largeBodyFill && largeBodyFill.pattern === "solid").toBeFalsy();
    expect(ws.getCell("B3006").value).toBe(1);
    expect(ws.getCell("C3007").value).toBe(3001);
  });

  it("never inserts theme branding, metadata or print layout in import-template sheets", async () => {
    const wb = await reread(report({
      mode: "import-template",
      appearance: { brandName: "Would be wrong", accentColor: "#00AABB" },
      sheets: [{
        kind: "table",
        name: "References",
        columns: [{ key: "ref", header: "Ref Code" }],
        rows: [{ ref: "00001" }],
      }],
    }));
    const ws = wb.getWorksheet("References")!;
    expect(ws.getCell("A1").value).toBe("Ref Code");
    expect(ws.getCell("A2").value).toBe("00001");
    expect(ws.getCell("A4").value).toBeNull();
    expect(ws.pageSetup.printArea).toBeUndefined();
    expect(ws.headerFooter.oddHeader || "").not.toContain("Dakzo");
  });

  it("does not restyle custom invoice forms, including existing print settings", () => {
    const ws = buildUniversalExcelWorkbook(report({
      appearance: { accentColor: "#002244" },
      sheets: [{
        kind: "custom",
        name: "Invoice",
        build(sheet) {
          sheet.getCell("A1").value = "Original Invoice";
          sheet.getCell("B9").value = { formula: "SUM(B4:B8)", result: 50 };
          sheet.pageSetup.orientation = "landscape";
        },
      }],
    })).workbook.getWorksheet("Invoice")!;
    expect(ws.getCell("A1").value).toBe("Original Invoice");
    expect(ws.getCell("B9").formula).toBe("SUM(B4:B8)");
    expect(ws.pageSetup.orientation).toBe("landscape");
    expect(ws.getCell("A4").value).toBeNull();
  });
});
