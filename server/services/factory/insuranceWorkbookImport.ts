import type { ExcelWorkbook } from "../../excelHelper";
import { createWorkbook, sheetToJsonWithRowNumbers } from "../../excelHelper";

export interface InsuranceImportRow {
  sheetName: string;
  monthStart: string;
  name: string;
  amount: string;
  startDate: string;
  nationality?: string;
  positionWorking?: string;
  insuranceNumber?: string;
  dob?: string;
  notes?: string;
}

export interface InsuranceImportIssue {
  sheetName: string;
  row?: number;
  message: string;
}

export interface InsuranceImportPreview {
  rows: InsuranceImportRow[];
  errors: InsuranceImportIssue[];
  warnings: InsuranceImportIssue[];
  recognizedSheets: Array<{ sheetName: string; monthStart: string; rowCount: number }>;
  ignoredSheets: string[];
}

export const INSURANCE_IMPORT_HEADERS = [
  "Name",
  "Monthly Amount",
  "Start Date",
  "Insurance Number",
  "Nationality",
  "Position",
  "Date of Birth",
  "Notes",
] as const;

const INSURANCE_TEMPLATE_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Creates a blank workbook that can be reused for any import year.
 *
 * Plain month sheet names are intentional: the import dialog's selected year
 * supplies the year when users fill in this reusable template.
 */
export function createInsuranceImportTemplate() {
  const workbook = createWorkbook();
  workbook.creator = "ERP";
  workbook.title = "Insurance Import Template";
  workbook.subject = "Monthly Insurance member import";
  workbook.description = "Blank monthly worksheets for importing Insurance member amounts.";

  for (const month of INSURANCE_TEMPLATE_MONTHS) {
    const worksheet = workbook.addWorksheet(month);
    worksheet.addRow([...INSURANCE_IMPORT_HEADERS]);
    worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    worksheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2563EB" },
    };
    worksheet.getRow(1).alignment = { vertical: "middle" };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: INSURANCE_IMPORT_HEADERS.length },
    };
    worksheet.columns = [
      { width: 28 },
      { width: 16 },
      { width: 14 },
      { width: 20 },
      { width: 18 },
      { width: 20 },
      { width: 14 },
      { width: 36 },
    ];
    worksheet.getColumn(2).numFmt = "0.00";
  }

  return workbook;
}

const MONTHS = new Map<string, number>([
  ["jan", 1],
  ["january", 1],
  ["feb", 2],
  ["february", 2],
  ["mar", 3],
  ["march", 3],
  ["apr", 4],
  ["april", 4],
  ["may", 5],
  ["jun", 6],
  ["june", 6],
  ["jul", 7],
  ["july", 7],
  ["aug", 8],
  ["august", 8],
  ["sep", 9],
  ["sept", 9],
  ["september", 9],
  ["oct", 10],
  ["october", 10],
  ["nov", 11],
  ["november", 11],
  ["dec", 12],
  ["december", 12],
] as const);

function monthStart(year: number, month: number): string | null {
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export function parseInsuranceSheetMonth(sheetName: string, defaultYear?: number): string | null {
  const normalized = sheetName.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  let match = normalized.match(/^(\d{4})[-/. ](\d{1,2})$/);
  if (match) return monthStart(Number(match[1]), Number(match[2]));
  match = normalized.match(/^(\d{1,2})[-/. ](\d{4})$/);
  if (match) return monthStart(Number(match[2]), Number(match[1]));
  match = normalized.match(/^([a-z]+)[-/. ]+(\d{4})$/);
  if (match) return monthStart(Number(match[2]), MONTHS.get(match[1]) ?? 0);
  match = normalized.match(/^(\d{4})[-/. ]+([a-z]+)$/);
  if (match) return monthStart(Number(match[1]), MONTHS.get(match[2]) ?? 0);
  const namedMonth = MONTHS.get(normalized);
  if (namedMonth && defaultYear != null) return monthStart(defaultYear, namedMonth);
  return null;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function findValue(row: Record<string, unknown>, aliases: string[]): unknown {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (normalizedAliases.has(normalizeHeader(key))) return value;
  }
  return undefined;
}

function normalizeAmount(value: unknown): string | null {
  const raw = cellText(value).replace(/[$€£,\s]/g, "");
  if (!raw) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return null;
  return number.toFixed(2);
}

function normalizeDate(value: unknown): string | null {
  const raw = cellText(value);
  if (!raw) return null;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const date = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : raw;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function parseInsuranceWorkbook(workbook: ExcelWorkbook, defaultYear?: number): InsuranceImportPreview {
  const preview: InsuranceImportPreview = {
    rows: [],
    errors: [],
    warnings: [],
    recognizedSheets: [],
    ignoredSheets: [],
  };
  const duplicateKeys = new Map<string, number>();

  for (const sheetName of workbook.SheetNames) {
    const parsedMonth = parseInsuranceSheetMonth(sheetName, defaultYear);
    if (!parsedMonth) {
      preview.ignoredSheets.push(sheetName);
      preview.warnings.push({
        sheetName,
        message: 'Sheet name is not a recognized month. Use "January", "January 2026", or "2026-01".',
      });
      continue;
    }

    const worksheet = workbook.Sheets[sheetName];
    const sourceRows = sheetToJsonWithRowNumbers<Record<string, unknown>>(worksheet);
    let validRows = 0;
    sourceRows.forEach(({ rowNumber, data: sourceRow }) => {
      const name = cellText(findValue(sourceRow, ["name", "full name", "member name", "employee name"]));
      const amount = normalizeAmount(
        findValue(sourceRow, ["monthly amount", "month amount", "insurance amount", "monthly", "amount"])
      );
      const rowHasAnyValue = Object.values(sourceRow).some((value) => cellText(value) !== "");
      if (!rowHasAnyValue) return;
      if (!name) {
        preview.errors.push({ sheetName, row: rowNumber, message: "Name is required." });
        return;
      }
      if (amount == null) {
        preview.errors.push({
          sheetName,
          row: rowNumber,
          message: "Monthly Amount must be a non-negative number.",
        });
        return;
      }

      const duplicateKey = `${parsedMonth}:${name.toLocaleLowerCase()}`;
      const firstRow = duplicateKeys.get(duplicateKey);
      if (firstRow != null) {
        preview.errors.push({
          sheetName,
          row: rowNumber,
          message: `Duplicate member for this month (first found on row ${firstRow}).`,
        });
        return;
      }
      duplicateKeys.set(duplicateKey, rowNumber);

      const requestedStartDate = findValue(sourceRow, ["start date", "startdate"]);
      const startDate =
        requestedStartDate == null || cellText(requestedStartDate) === ""
          ? parsedMonth
          : normalizeDate(requestedStartDate);
      if (!startDate) {
        preview.errors.push({ sheetName, row: rowNumber, message: "Start Date is invalid." });
        return;
      }
      const requestedDob = findValue(sourceRow, ["date of birth", "dob", "birth date"]);
      const dob =
        requestedDob == null || cellText(requestedDob) === "" ? undefined : (normalizeDate(requestedDob) ?? undefined);
      if (requestedDob != null && cellText(requestedDob) !== "" && !dob) {
        preview.errors.push({ sheetName, row: rowNumber, message: "Date of Birth is invalid." });
        return;
      }

      preview.rows.push({
        sheetName,
        monthStart: parsedMonth,
        name,
        amount,
        startDate,
        nationality: cellText(findValue(sourceRow, ["nationality"])) || undefined,
        positionWorking: cellText(findValue(sourceRow, ["position", "position working", "job title"])) || undefined,
        insuranceNumber:
          cellText(findValue(sourceRow, ["insurance number", "insurance no", "insurance #"])) || undefined,
        dob,
        notes: cellText(findValue(sourceRow, ["notes", "note"])) || undefined,
      });
      validRows += 1;
    });

    preview.recognizedSheets.push({ sheetName, monthStart: parsedMonth, rowCount: validRows });
    if (sourceRows.length === 0) {
      preview.warnings.push({ sheetName, message: "Sheet has no data rows." });
    }
  }

  if (preview.recognizedSheets.length === 0) {
    preview.errors.push({ sheetName: "", message: "No month-named worksheets were found." });
  } else if (preview.rows.length === 0 && preview.errors.length === 0) {
    preview.errors.push({ sheetName: "", message: "No importable member rows were found." });
  }
  return preview;
}
