/**
 * Insurance workbook import parsing (server/services/factory/insuranceWorkbookImport.ts):
 * every sheet-name month format and its range checks, the reusable template,
 * and row validation (blank rows, missing names, bad amounts, duplicates,
 * start and birth dates, optional columns, empty sheets, no usable sheets).
 */
import { describe, expect, it } from "vitest";

import {
  createWorkbook,
  readExcel,
  sheetToJson,
  sheetToJsonWithRowNumbers,
  writeWorkbook,
} from "../server/excelHelper";
import {
  INSURANCE_IMPORT_HEADERS,
  createInsuranceImportTemplate,
  parseInsuranceSheetMonth,
  parseInsuranceWorkbook,
} from "../server/services/factory/insuranceWorkbookImport";

async function workbookOf(sheets: Record<string, unknown[][]>) {
  const book = createWorkbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = book.addWorksheet(name);
    for (const row of rows) sheet.addRow(row);
  }
  return readExcel(await writeWorkbook(book));
}

describe("parseInsuranceSheetMonth", () => {
  it.each([
    ["2026-03", undefined, "2026-03-01"],
    ["2026/3", undefined, "2026-03-01"],
    ["03.2026", undefined, "2026-03-01"],
    ["Sept 2026", undefined, "2026-09-01"],
    ["march_2026", undefined, "2026-03-01"],
    ["2026 Dec", undefined, "2026-12-01"],
    ["  January  ", 2027, "2027-01-01"],
    ["January", undefined, null],
    ["Smarch 2026", undefined, null],
    ["2026 Smarch", undefined, null],
    ["2026-13", undefined, null],
    ["1999-05", undefined, null],
    ["May", 2101, null],
    ["Summary", 2026, null],
  ])("%s (default year %s) -> %s", (name, year, expected) => {
    expect(parseInsuranceSheetMonth(name, year)).toBe(expected);
  });
});

describe("createInsuranceImportTemplate", () => {
  it("creates twelve plain month sheets with the import headers", () => {
    const book = createInsuranceImportTemplate();
    expect(book.worksheets.map((sheet) => sheet.name)).toHaveLength(12);
    expect(book.worksheets[0].name).toBe("January");
    expect(book.worksheets[11].getRow(1).values).toEqual([undefined, ...INSURANCE_IMPORT_HEADERS]);
  });
});

describe("sheetToJsonWithRowNumbers", () => {
  it("carries the real sheet row past rows the reader skips, leaving sheetToJson unchanged", async () => {
    const book = await workbookOf({
      S: [["Name", "Amount"], ["a", 1], [], ["", ""], [null, null], ["b", 2]],
    });
    const numbered = sheetToJsonWithRowNumbers(book.Sheets.S);
    expect(numbered).toEqual([
      { rowNumber: 2, data: { Name: "a", Amount: 1 } },
      { rowNumber: 4, data: { Name: "", Amount: "" } },
      { rowNumber: 6, data: { Name: "b", Amount: 2 } },
    ]);
    expect(sheetToJson(book.Sheets.S)).toEqual(numbered.map((row) => row.data));
  });
});

describe("parseInsuranceWorkbook", () => {
  it("imports valid rows with optional columns and reports every row-level problem", async () => {
    const workbook = await workbookOf({
      "2026-04": [
        ["Full Name", "Amount", "Start Date", "Insurance No", "Nationality", "Job Title", "DOB", "Note"],
        ["Ada Kamau", "$1,250.50", "", "INS-1", "Kenyan", "Driver", "1990-02-03", "first"],
        ["Ben Osei", 80, "2026-04-15", "", "", "", "", ""],
        [],
        ["", 10, "", "", "", "", "", ""],
        ["Cleo", "abc", "", "", "", "", "", ""],
        ["Dee", -5, "", "", "", "", "", ""],
        ["ada kamau", 5, "", "", "", "", "", ""],
        ["Eve", 5, "not a date", "", "", "", "", ""],
        ["Finn", 5, "", "", "", "", "yesterday-ish", ""],
        ["Gus", 5, "April 20, 2026", "", "", "", "", ""],
      ],
    });
    const preview = parseInsuranceWorkbook(workbook);
    expect(preview.recognizedSheets).toEqual([{ sheetName: "2026-04", monthStart: "2026-04-01", rowCount: 3 }]);
    expect(preview.rows[0]).toEqual({
      sheetName: "2026-04",
      monthStart: "2026-04-01",
      name: "Ada Kamau",
      amount: "1250.50",
      startDate: "2026-04-01",
      nationality: "Kenyan",
      positionWorking: "Driver",
      insuranceNumber: "INS-1",
      dob: "1990-02-03",
      notes: "first",
    });
    expect(preview.rows[1]).toMatchObject({ name: "Ben Osei", amount: "80.00", startDate: "2026-04-15" });
    expect(preview.rows[1].nationality).toBeUndefined();
    expect(preview.rows[2]).toMatchObject({ name: "Gus" });
    expect(preview.rows[2].startDate).toMatch(/^2026-04-(19|20)$/);
    // Errors name the real sheet row: the empty sheet row 4 has no cells, so
    // the reader skips it, yet the "Name is required." row is still row 5.
    expect(preview.errors.map((e) => [e.row, e.message])).toEqual([
      [5, "Name is required."],
      [6, "Monthly Amount must be a non-negative number."],
      [7, "Monthly Amount must be a non-negative number."],
      [8, "Duplicate member for this month (first found on row 2)."],
      [9, "Start Date is invalid."],
      [10, "Date of Birth is invalid."],
    ]);

    const gaps = parseInsuranceWorkbook(
      await workbookOf({
        "2026-05": [["Name", "Monthly Amount"], [], ["Ann", 5], ["", ""], [null, null], ["ann", 5]],
      })
    );
    expect(gaps.errors).toEqual([
      { sheetName: "2026-05", row: 6, message: "Duplicate member for this month (first found on row 3)." },
    ]);
  });

  it("warns about ignored and empty sheets and errors when nothing is importable", async () => {
    const onlyIgnored = parseInsuranceWorkbook(await workbookOf({ Summary: [["Name"], ["x"]] }), 2026);
    expect(onlyIgnored.ignoredSheets).toEqual(["Summary"]);
    expect(onlyIgnored.errors).toEqual([{ sheetName: "", message: "No month-named worksheets were found." }]);

    const empty = parseInsuranceWorkbook(await workbookOf({ May: [["Name", "Monthly Amount"]] }), 2026);
    expect(empty.recognizedSheets).toEqual([{ sheetName: "May", monthStart: "2026-05-01", rowCount: 0 }]);
    expect(empty.warnings).toEqual([{ sheetName: "May", message: "Sheet has no data rows." }]);
    expect(empty.errors).toEqual([{ sheetName: "", message: "No importable member rows were found." }]);

    const onlyBad = parseInsuranceWorkbook(
      await workbookOf({
        June: [
          ["Name", "Monthly Amount"],
          ["", 3],
        ],
      }),
      2026
    );
    expect(onlyBad.errors).toEqual([{ sheetName: "June", row: 2, message: "Name is required." }]);
  });

  it("keeps the same member in different months", async () => {
    const preview = parseInsuranceWorkbook(
      await workbookOf({
        "Jan 2026": [
          ["Name", "Monthly Amount", "Start Date"],
          ["Ada", 5, new Date("2026-01-09T00:00:00Z")],
        ],
        "Feb 2026": [
          ["Name", "Monthly Amount"],
          ["Ada", 6],
        ],
      })
    );
    expect(preview.rows.map((r) => [r.monthStart, r.startDate])).toEqual([
      ["2026-01-01", "2026-01-09"],
      ["2026-02-01", "2026-02-01"],
    ]);
    expect(preview.errors).toEqual([]);
  });
});
