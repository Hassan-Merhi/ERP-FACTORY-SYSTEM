/**
 * Spreadsheet helpers of the Retail supplier stock import dialog (split out of
 * RetailSupplierImportDialog.tsx): the downloadable template and the
 * read-and-validate step that turns an uploaded .xlsx/.csv into draft rows.
 */
import { read, utils, writeFile } from "@/lib/excelHelper";
import {
  RETAIL_SUPPLIER_IMPORT_LIMIT,
  RETAIL_SUPPLIER_TEMPLATE_COLUMNS,
  parseRetailSupplierImportRows,
  type RetailSupplierImportRow,
} from "./retailSupplierImportDraft";

type SourceRow = { rowNumber: number; values: Record<string, unknown> };

export function localISODate() {
  const date = new Date();
  const digits = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${digits(date.getMonth() + 1)}-${digits(date.getDate())}`;
}

function spreadsheetText(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if ("result" in value) return value.result;
  if ("text" in value) return value.text;
  if ("richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part: { text?: string }) => part.text ?? "").join("");
  }
  return value;
}

export async function downloadSupplierTemplate() {
  const sample = [
    {
      "Item Name": "Runner 270",
      Category: "Shoes",
      Brand: "Acme",
      Size: "42",
      Color: "Black",
      Quantity: 10,
      "Cost Price": 35,
      "Selling Price": 65,
      "Main Image": "runner-black.jpg",
      "Extra Images": "runner-black-side.jpg; runner-black-back.jpg",
      SKU: "",
      Barcode: "",
      Description: "Demo example - replace before uploading",
    },
    {
      "Item Name": "Cotton T-Shirt",
      Category: "Clothing",
      Brand: "Acme",
      Size: "M",
      Color: "White",
      Quantity: 20,
      "Cost Price": 12,
      "Selling Price": 24.99,
      "Main Image": "tee-white.jpg",
      "Extra Images": "",
      SKU: "",
      Barcode: "",
      Description: "Demo example - replace before uploading",
    },
  ];
  const workbook = utils.book_new();
  const sheet = utils.json_to_sheet(sample, { header: [...RETAIL_SUPPLIER_TEMPLATE_COLUMNS] });
  const worksheet = utils.book_append_sheet(workbook, sheet, "Supplier Stock");
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).height = 24;
  worksheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B365D" } };
  });
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  // Preserve leading zeros in supplier barcodes and SKUs; never use Excel's
  // numeric/scientific display for scanner identities.
  worksheet.getColumn(11).numFmt = "@";
  worksheet.getColumn(12).numFmt = "@";
  worksheet.columns.forEach((column, index) => {
    column.width = index === 0 || index === 8 || index === 9 ? 29 : 17;
  });
  await writeFile(workbook, "retail_supplier_stock_template.xlsx");
}

/** Read the first worksheet of a supplier spreadsheet into validated draft rows; throws a user-facing message. */
export async function parseRetailSupplierSpreadsheetFile(file: File): Promise<RetailSupplierImportRow[]> {
  const workbook = await read(await file.arrayBuffer());
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!worksheet) throw new Error("Spreadsheet has no worksheets");
  const headers: string[] = [];
  const sourceRows: SourceRow[] = [];
  worksheet.eachRow((excelRow, rowNumber) => {
    if (rowNumber === 1) {
      excelRow.eachCell((cell, colNumber) => {
        headers[colNumber - 1] = String(spreadsheetText(cell.value) ?? "").trim();
      });
      return;
    }
    const values: Record<string, unknown> = {};
    excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber - 1];
      if (header) values[header] = spreadsheetText(cell.value);
    });
    if (Object.values(values).some((value) => value !== null && value !== undefined && String(value).trim())) {
      sourceRows.push({ rowNumber, values });
    }
  });
  const normalizedHeaders = headers.map((header) => header.toLowerCase().replace(/[ _-]+/g, ""));
  if (!normalizedHeaders.some((header) => header === "itemname" || header === "name")) {
    throw new Error("Missing Item Name column. Download the supplier template and keep its header row.");
  }
  if (!normalizedHeaders.includes("quantity") && !normalizedHeaders.includes("qty")) {
    throw new Error("Missing Quantity column");
  }
  if (!sourceRows.length) throw new Error("No stock rows found in the spreadsheet");
  if (sourceRows.length > RETAIL_SUPPLIER_IMPORT_LIMIT) {
    throw new Error(`Maximum ${RETAIL_SUPPLIER_IMPORT_LIMIT.toLocaleString()} rows per import`);
  }
  return parseRetailSupplierImportRows(sourceRows);
}
