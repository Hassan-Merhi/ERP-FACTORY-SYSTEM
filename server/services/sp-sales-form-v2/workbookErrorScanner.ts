import ExcelJS from "exceljs";
import { cellResultText } from "../../lib/excelCellValue";
import { EXCEL_ERRORS } from "./constants";

// ── Error scanner ─────────────────────────────────────────────────────────────
// NOTE: this sees only errors carried as text. An error cached as the object
// `{ error: "#DIV/0!" }` reads as null and is missed — see `cellResultText`.
export function scanErrors(wb: ExcelJS.Workbook): Array<{ sheet: string; cell: string; value: string }> {
  const found: Array<{ sheet: string; cell: string; value: string }> = [];
  for (const ws of wb.worksheets) {
    if (ws.state === "hidden" || ws.state === "veryHidden") continue;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const check = cellResultText(cell.value);
        if (check !== null && EXCEL_ERRORS.some((e) => check.includes(e))) {
          found.push({ sheet: ws.name, cell: cell.address, value: check });
        }
      });
    });
  }
  return found;
}
