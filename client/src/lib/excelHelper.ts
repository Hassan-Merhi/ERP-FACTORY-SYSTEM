import ExcelJS from "exceljs";
import Papa from "papaparse";
import { downloadBlob } from "./downloadBlob";
export { utils } from "./excelHelperPlainCellValue";
export type { ExcelRange } from "./excelHelperPlainCellValue";

function binaryStringToArrayBuffer(s: string): ArrayBuffer {
  const buf = new ArrayBuffer(s.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xff;
  return buf;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}

function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function hasZipSignature(bytes: Uint8Array, index: number, third: number, fourth: number): boolean {
  return (
    index >= 0 &&
    index + 3 < bytes.length &&
    bytes[index] === 0x50 &&
    bytes[index + 1] === 0x4b &&
    bytes[index + 2] === third &&
    bytes[index + 3] === fourth
  );
}

function findLastCompleteXlsxZip(bytes: Uint8Array): Uint8Array | null {
  // A Node Buffer can be a view into a shared slab. Once callers pass only
  // Buffer#buffer, the original byteOffset/byteLength are lost, so the backing
  // ArrayBuffer may contain older ZIPs before the workbook and unrelated bytes
  // after it. Recover the newest complete ZIP by validating its EOCD and central
  // directory instead of stopping at the first local-file header.
  if (bytes.length < 22) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let eocd = bytes.length - 22; eocd >= 0; eocd -= 1) {
    if (!hasZipSignature(bytes, eocd, 0x05, 0x06)) continue;

    const commentLength = view.getUint16(eocd + 20, true);
    const archiveEnd = eocd + 22 + commentLength;
    if (archiveEnd > bytes.length) continue;

    const centralDirectorySize = view.getUint32(eocd + 12, true);
    const centralDirectoryOffset = view.getUint32(eocd + 16, true);
    const archiveStart = eocd - centralDirectorySize - centralDirectoryOffset;
    if (archiveStart < 0 || !hasZipSignature(bytes, archiveStart, 0x03, 0x04)) {
      continue;
    }

    const centralDirectoryStart = archiveStart + centralDirectoryOffset;
    if (centralDirectorySize > 0 && !hasZipSignature(bytes, centralDirectoryStart, 0x01, 0x02)) {
      continue;
    }

    return bytes.slice(archiveStart, archiveEnd);
  }

  return null;
}

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  const bytes = isUint8Array(data) ? Uint8Array.from(data) : new Uint8Array(data);

  // A Uint8Array preserves its exact view, so a normal XLSX can be used as-is.
  if (isUint8Array(data) && isXlsxZip(bytes)) return bytes;

  // ArrayBuffer inputs can come from Buffer#buffer and therefore include the
  // surrounding slab. Trim to the last structurally complete XLSX archive.
  const recoveredZip = findLastCompleteXlsxZip(bytes);
  return recoveredZip ?? bytes;
}

function isXlsxZip(bytes: Uint8Array): boolean {
  return hasZipSignature(bytes, 0, 0x03, 0x04);
}

async function loadSpreadsheet(workbook: ExcelJS.Workbook, bytes: Uint8Array): Promise<void> {
  if (isXlsxZip(bytes)) {
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
    return;
  }

  const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
  // Papa cannot detect a delimiter in a blank file and would report that
  // instead, which tells the user nothing about what is wrong.
  if (!text.trim()) {
    throw new Error("CSV file is empty");
  }
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });

  if (parsed.errors.length > 0) {
    throw new Error(`Could not parse CSV: ${parsed.errors[0].message}`);
  }
  if (parsed.data.length === 0) {
    throw new Error("CSV file is empty");
  }

  const worksheet = workbook.addWorksheet("Sheet1");
  for (const row of parsed.data) {
    worksheet.addRow(row);
  }
}

function isNoCostContainerItemsSheet(worksheet: ExcelJS.Worksheet): boolean {
  return (
    worksheet.name === "Container Items" &&
    worksheet.getCell("A3").text.trim().toUpperCase() === "NO" &&
    worksheet.getCell("B3").text.trim().toUpperCase() === "BARCODE" &&
    worksheet.getCell("C3").text.trim().toUpperCase() === "DESCRIPTION" &&
    worksheet.getCell("D3").text.trim().toUpperCase() === "Q'TY"
  );
}

function prepareNoCostContainerItemsSheet(worksheet: ExcelJS.Worksheet): void {
  if (!isNoCostContainerItemsSheet(worksheet)) return;

  const existingLastRow = worksheet.rowCount;
  const hasTotalRow = worksheet.getCell(`A${existingLastRow}`).text.trim().toUpperCase() === "TOTAL Q'TY";
  const dataEndRow = hasTotalRow ? existingLastRow - 1 : existingLastRow;

  const rows: Array<{
    barcode: ExcelJS.CellValue;
    description: ExcelJS.CellValue;
    descriptionText: string;
    quantity: ExcelJS.CellValue;
  }> = [];

  for (let rowNumber = 4; rowNumber <= dataEndRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    rows.push({
      barcode: row.getCell(2).value,
      description: row.getCell(3).value,
      descriptionText: row.getCell(3).text.trim(),
      quantity: row.getCell(4).value,
    });
  }

  rows.sort((left, right) =>
    left.descriptionText.localeCompare(right.descriptionText, undefined, {
      sensitivity: "base",
      numeric: true,
    })
  );

  rows.forEach((item, index) => {
    const row = worksheet.getRow(index + 4);
    row.getCell(1).value = index + 1;
    row.getCell(2).value = item.barcode;
    row.getCell(3).value = item.description;
    row.getCell(4).value = item.quantity;
  });

  const totalRowNumber = hasTotalRow ? existingLastRow : dataEndRow + 1;
  const totalRow = worksheet.getRow(totalRowNumber);
  totalRow.getCell(1).value = "TOTAL Q'TY";
  if (!hasTotalRow) {
    worksheet.mergeCells(`A${totalRowNumber}:C${totalRowNumber}`);
  }
  totalRow.getCell(4).value = rows.length > 0 ? { formula: `SUM(D4:D${3 + rows.length})` } : 0;
  totalRow.height = 24;
  totalRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1B2A4A" },
    };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = {
      horizontal: colNum === 4 ? "center" : "right",
      vertical: "middle",
    };
    cell.border = {
      top: { style: "thin" },
      bottom: { style: "thin" },
      left: { style: "thin" },
      right: { style: "thin" },
    };
  });
  totalRow.getCell(4).numFmt = "#,##0.##";

  worksheet.pageSetup.orientation = "portrait";
  worksheet.pageSetup.fitToPage = true;
  worksheet.pageSetup.fitToWidth = 1;
  worksheet.pageSetup.fitToHeight = 0;
  worksheet.pageSetup.horizontalCentered = true;
  worksheet.pageSetup.printArea = `A1:D${totalRowNumber}`;
  worksheet.pageSetup.printTitlesRow = "1:3";
  worksheet.pageSetup.margins = {
    left: 0.25,
    right: 0.25,
    top: 0.5,
    bottom: 0.5,
    header: 0.2,
    footer: 0.2,
  };
}

type WorkbookConstructor = new () => ExcelJS.Workbook;
const OriginalWorkbook = ExcelJS.Workbook;

class ExportAwareWorkbook extends OriginalWorkbook {
  private containerItemsWorksheet: ExcelJS.Worksheet | null = null;
  private containerItemsWriteHookInstalled = false;

  override addWorksheet(name?: string, options?: Partial<ExcelJS.AddWorksheetOptions>): ExcelJS.Worksheet {
    const worksheet = super.addWorksheet(name, options);
    if (name === "Container Items") {
      this.containerItemsWorksheet = worksheet;
      this.installContainerItemsWriteHook();
    }
    return worksheet;
  }

  private installContainerItemsWriteHook(): void {
    if (this.containerItemsWriteHookInstalled) return;
    this.containerItemsWriteHookInstalled = true;

    const originalWriteBuffer = this.xlsx.writeBuffer.bind(this.xlsx);
    this.xlsx.writeBuffer = async () => {
      if (this.containerItemsWorksheet) {
        prepareNoCostContainerItemsSheet(this.containerItemsWorksheet);
      }
      return originalWriteBuffer();
    };
  }
}

(ExcelJS as unknown as { Workbook: WorkbookConstructor }).Workbook = ExportAwareWorkbook as WorkbookConstructor;

export async function writeFile(workbook: ExcelJS.Workbook, filename: string): Promise<void> {
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob(blob, filename);
}

export async function readFile(file: File): Promise<ExcelJS.Workbook> {
  const buffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await loadSpreadsheet(workbook, new Uint8Array(buffer));
  return workbook;
}

export async function readFromBuffer(data: ArrayBuffer | Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await loadSpreadsheet(workbook, toBytes(data));
  return workbook;
}

export interface WorkbookData {
  workbook: ExcelJS.Workbook;
  SheetNames: string[];
  Sheets: Record<string, ExcelJS.Worksheet>;
}

export async function read(
  data: ArrayBuffer | Uint8Array | File | string | null | undefined,
  _options?: { type?: "array" | "binary" | "buffer" | "string" }
): Promise<WorkbookData> {
  const workbook = new ExcelJS.Workbook();
  if (data == null) {
    throw new Error("read: no data provided");
  }
  if (typeof File !== "undefined" && data instanceof File) {
    const buffer = await data.arrayBuffer();
    await loadSpreadsheet(workbook, new Uint8Array(buffer));
  } else if (typeof data === "string") {
    await loadSpreadsheet(workbook, new Uint8Array(binaryStringToArrayBuffer(data)));
  } else if (isArrayBuffer(data) || isUint8Array(data)) {
    await loadSpreadsheet(workbook, toBytes(data));
  } else {
    throw new Error("read: unsupported data type");
  }

  const SheetNames: string[] = [];
  const Sheets: Record<string, ExcelJS.Worksheet> = {};

  workbook.eachSheet((worksheet) => {
    SheetNames.push(worksheet.name);
    Sheets[worksheet.name] = worksheet;
  });

  return { workbook, SheetNames, Sheets };
}

export { ExcelJS };
