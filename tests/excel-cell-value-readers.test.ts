/**
 * Typed readers for ExcelJS cell values.
 *
 * The supplier-partner sales-form exporters read cells that may be plain scalars,
 * rich text, or formula cells carrying a cached `result`. That reading used to go
 * through `any`, so only the arm each author had in mind was actually covered.
 *
 * These pin every arm, and — importantly — pin the one gap the exporters still
 * have, so it is a documented, tested fact rather than an accident: an Excel
 * error cached as the object `{ error: "#DIV/0!" }` is invisible to the workbook
 * error scanners. See the note on `cellResultText` for why closing that gap is a
 * template repair, not a typing change.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { cellErrorText, cellFormula, cellResultText, cellText, isCellErrorValue } from "../server/lib/excelCellValue";
import { scanErrors } from "../server/services/sp-sales-form-v2/workbookErrorScanner";

/** Round-trips a workbook through xlsx so cells come back as ExcelJS parses them, not as they were set. */
async function roundTrip(build: (ws: ExcelJS.Worksheet) => void): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  build(wb.addWorksheet("ENTRY"));
  const buf = await wb.xlsx.writeBuffer();
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.load(buf);
  return reread;
}

describe("cellText", () => {
  it("prefers a plain string and falls back to a string formula result", () => {
    expect(cellText("  Sugar  ")).toBe("Sugar");
    expect(cellText({ formula: "A1", result: "  Rice  " })).toBe("Rice");
  });

  it("is empty for a formula whose cached result is not text", () => {
    expect(cellText({ formula: "A1", result: 12 })).toBe("");
    expect(cellText({ formula: "A1", result: { error: "#N/A" } })).toBe("");
  });

  it("is empty for cells that carry no text at all", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
    expect(cellText(42)).toBe("");
    expect(cellText({ richText: [{ text: "plain" }] })).toBe("");
  });
});

describe("cellFormula", () => {
  it("prefers an own formula and falls back to a shared one", () => {
    expect(cellFormula({ formula: "SUM(A1:A2)" })).toBe("SUM(A1:A2)");
    expect(cellFormula({ sharedFormula: "B1" })).toBe("B1");
  });

  it("keeps an empty own formula rather than falling through to the shared one", () => {
    // Matches the `formula ?? sharedFormula ?? ""` chain this replaced: `??`
    // falls through on undefined, not on "".
    expect(cellFormula({ formula: "", sharedFormula: "B1" })).toBe("");
  });

  it("is empty for a cell that holds no formula", () => {
    expect(cellFormula("text")).toBe("");
    expect(cellFormula({ error: "#REF!" })).toBe("");
    expect(cellFormula(null)).toBe("");
  });
});

describe("isCellErrorValue", () => {
  it("accepts only an object whose error is a string", () => {
    expect(isCellErrorValue({ error: "#NULL!" })).toBe(true);
    expect(isCellErrorValue({ error: 7 })).toBe(false);
    expect(isCellErrorValue({ result: "#REF!" })).toBe(false);
    expect(isCellErrorValue(null)).toBe(false);
    expect(isCellErrorValue("#REF!")).toBe(false);
  });
});

describe("cellResultText", () => {
  it("reads a string result and a plain string cell", () => {
    expect(cellResultText({ formula: "A1", result: "#NAME?" })).toBe("#NAME?");
    expect(cellResultText("#VALUE!")).toBe("#VALUE!");
  });

  it("is null for non-text results", () => {
    expect(cellResultText({ formula: "B2/C2", result: 5 })).toBeNull();
    expect(cellResultText(42)).toBeNull();
    expect(cellResultText(null)).toBeNull();
  });

  it("does NOT see an error cached as an object — the exporters' known gap", () => {
    expect(cellResultText({ formula: "B1/C1", result: { error: "#DIV/0!" } })).toBeNull();
    expect(cellResultText({ error: "#REF!" })).toBeNull();
  });
});

describe("cellErrorText", () => {
  it("sees every arm that can carry an error, including the object arms", () => {
    expect(cellErrorText({ formula: "B1/C1", result: { error: "#DIV/0!" } })).toBe("#DIV/0!");
    expect(cellErrorText({ error: "#REF!" })).toBe("#REF!");
    expect(cellErrorText({ formula: "A1", result: "#NAME?" })).toBe("#NAME?");
    expect(cellErrorText("#VALUE!")).toBe("#VALUE!");
  });

  it("is null where there is no error text to read", () => {
    expect(cellErrorText({ formula: "B2/C2", result: 5 })).toBeNull();
    expect(cellErrorText(42)).toBeNull();
    expect(cellErrorText(null)).toBeNull();
    expect(cellErrorText({ richText: [{ text: "plain" }] })).toBeNull();
  });
});

describe("scanErrors on a re-read workbook", () => {
  it("reports an error carried as a string result", async () => {
    const wb = await roundTrip((ws) => {
      ws.getCell("A1").value = { formula: "VLOOKUP(1,X:Y,2,0)", result: "#N/A" };
    });

    expect(scanErrors(wb)).toEqual([{ sheet: "ENTRY", cell: "A1", value: "#N/A" }]);
  });

  it("stays silent on a healthy workbook", async () => {
    const wb = await roundTrip((ws) => {
      ws.getCell("A1").value = { formula: "B1/C1", result: 5 };
      ws.getCell("A2").value = "Sugar";
      ws.getCell("A3").value = 12;
    });

    expect(scanErrors(wb)).toEqual([]);
  });

  it("misses an error cached as an object, and cellErrorText would catch it", async () => {
    const wb = await roundTrip((ws) => {
      ws.getCell("A1").value = { formula: "B1/C1", result: { error: "#DIV/0!" } };
    });

    expect(scanErrors(wb)).toEqual([]);
    expect(cellErrorText(wb.getWorksheet("ENTRY")!.getCell("A1").value)).toBe("#DIV/0!");
  });

  it("skips hidden sheets", async () => {
    const wb = new ExcelJS.Workbook();
    const hidden = wb.addWorksheet("Scratch");
    hidden.state = "hidden";
    hidden.getCell("A1").value = { formula: "A1", result: "#REF!" };

    expect(scanErrors(wb)).toEqual([]);
  });
});
