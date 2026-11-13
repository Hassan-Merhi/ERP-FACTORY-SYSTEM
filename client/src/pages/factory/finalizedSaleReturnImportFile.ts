import type ExcelJS from "exceljs";

const REFERENCE_HEADERS = new Set([
  "ref", "refcode", "reference", "referencecode", "referencenumber",
  "balereference", "baleref", "balerefcode", "balereferencenumber",
  "barcode", "barcodenumber", "balebarcode", "balecode", "stockreference",
]);
const MAX_ROWS = 1000;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const clean = (text: string) => text.replace(/^\uFEFF/, "").trim();
const headerKey = (text: string) => clean(text).toLowerCase().replace(/[^a-z0-9]/g, "");

/** Parse one reference per row; use the reference column, never quantity or article SKU columns. */
export function extractFinalizedReturnReferences(sheet: ExcelJS.Worksheet): string[] {
  if (!sheet || !sheet.actualRowCount) throw new Error("The spreadsheet has no references");
  let column = 1;
  let startRow = 1;
  for (let rowIndex = 1; rowIndex <= Math.min(sheet.rowCount, 10); rowIndex += 1) {
    const row = sheet.getRow(rowIndex);
    for (let colIndex = 1; colIndex <= Math.min(row.cellCount, 30); colIndex += 1) {
      if (REFERENCE_HEADERS.has(headerKey(row.getCell(colIndex).text))) {
        column = colIndex;
        startRow = rowIndex + 1;
        break;
      }
    }
    if (startRow !== 1) break;
  }
  // If no known header was found, accept a one-column headerless list.
  if (startRow === 1 && sheet.getRow(1).cellCount > 1) {
    throw new Error("No Ref Code / Reference / Barcode column found. Add a 'Ref Code' header.");
  }
  const references: string[] = [];
  for (let rowIndex = startRow; rowIndex <= sheet.rowCount; rowIndex += 1) {
    const cell = sheet.getRow(rowIndex).getCell(column);
    const value = clean(cell.text);
    if (!value) continue;
    if (value.length > 100) throw new Error("Reference on row " + rowIndex + " exceeds 100 characters");
    references.push(value);
    if (references.length > MAX_ROWS) throw new Error("Maximum 1,000 reference codes per Excel import");
  }
  if (!references.length) throw new Error("The spreadsheet has no reference codes");
  return references;
}

export async function readFinalizedReturnImport(file: File): Promise<string[]> {
  if (!/\.(xlsx|csv)$/i.test(file.name))
    throw new Error("Select a .xlsx or .csv file containing bale reference codes");
  if (file.size > MAX_FILE_SIZE || !file.size)
    throw new Error("Spreadsheet is empty or exceeds 5 MB");
  const { read } = await import("@/lib/excelHelper");
  const workbook = await read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The spreadsheet has no worksheet");
  return extractFinalizedReturnReferences(sheet);
}
