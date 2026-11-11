/** Exactly the ERP PO Import template (first worksheet, exact 13 headers).
 * Do not add decorative title rows above row 1. Importer reads the first sheet.
 */
import type ExcelJS from "exceljs";
import { createWorkbook } from "../../../excelHelper";
import { TRIP_PO_HEADERS, type TripPoExportResult } from "./loadingDispatchPoExportModel";

export function buildTripPoImportWorkbook(exportData: TripPoExportResult): ExcelJS.Workbook {
  const wb = createWorkbook();
  wb.creator = "Factory Dispatch Management";
  wb.subject = "ERP PO Import — manually imported by ERP operator";
  const ws = wb.addWorksheet("PO Import", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.addRow([...TRIP_PO_HEADERS]);
  for (const entry of exportData.rows) {
    ws.addRow(TRIP_PO_HEADERS.map(key => entry[key]));
  }

  ws.columns = [
    { width: 23 }, { width: 27 }, { width: 22 }, { width: 22 },
    { width: 42 }, { width: 13 }, { width: 14 }, { width: 13 },
    { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 20 },
  ];
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16355E" } };
  header.height = 25;
  header.alignment = { vertical: "middle" };
  // String identifiers remain strings, including leading zeros; never
  // interpret ERP article codes as Excel barcodes or numeric stock IDs.
  for (const i of [1, 2, 3, 4, 5, 8]) ws.getColumn(i).numFmt = "@";
  ws.getColumn(6).numFmt = "0";
  for (const i of [7, 9, 10, 11, 12, 13]) ws.getColumn(i).numFmt = "#,##0.00";
  ws.autoFilter = { from: "A1", to: "M" + Math.max(2, ws.rowCount) };
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    if (i % 2 === 0) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F6FB" } };
    row.alignment = { vertical: "middle" };
  }
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  return wb;
}
