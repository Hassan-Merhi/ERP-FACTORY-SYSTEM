import { styleSpecializedWorkbook } from "@shared/universal-excel/specializedWorkbookStyle";
import { cellFormula, cellResultText } from "../../lib/excelCellValue";
import { toArrayBuffer } from "../../lib/bufferCompatibility";
import ExcelJS from "exceljs";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";

import {
  EXCEL_ERRORS,
  E_DATA_START,
  E_NAME_COL,
  S_DATE_ROW,
  S_DATE_START,
  S_NAME_COL,
  SpSalesFormParams,
} from "./layout";
import { generateSpSalesFormExcelStep1 } from "./generateSpSalesFormExcelStep1";
import { generateSpSalesFormExcelStep2 } from "./generateSpSalesFormExcelStep2";
import { generateSpSalesFormExcelStep3 } from "./generateSpSalesFormExcelStep3";

export async function generateSpSalesFormExcel(params: SpSalesFormParams): Promise<Buffer> {
  const {
    E_DATA_END,
    costingWs,
    dates,
    dayCount,
    effectiveDayCount,
    entryWs,
    fromDate,
    getOpening,
    getSalesMap,
    itemRows,
    nameToSystemCode,
    salesWs,
    startDate,
    summaryIWs,
    toDate,
    wb,
  } = await generateSpSalesFormExcelStep1(params);
  generateSpSalesFormExcelStep2({
    E_DATA_END,
    costingWs,
    dates,
    effectiveDayCount,
    entryWs,
    getOpening,
    getSalesMap,
    itemRows,
    nameToSystemCode,
    salesWs,
    startDate,
  });
  generateSpSalesFormExcelStep3({
    E_DATA_END,
    costingWs,
    dates,
    effectiveDayCount,
    entryWs,
    getOpening,
    getSalesMap,
    itemRows,
    nameToSystemCode,
    salesWs,
    startDate,
    summaryIWs,
    toDate,
  });
  const { buf } = await generateSpSalesFormExcelStep4({ E_DATA_END, dayCount, entryWs, fromDate, salesWs, wb });

  return buf;
}

async function generateSpSalesFormExcelStep4({
  E_DATA_END,
  dayCount,
  entryWs,
  fromDate,
  salesWs,
  wb,
}: Pick<
  Awaited<ReturnType<typeof generateSpSalesFormExcelStep1>>,
  "E_DATA_END" | "dayCount" | "entryWs" | "fromDate" | "salesWs" | "wb"
>) {
  // ENTRY, Summary, Ageing: leave as visible (template default)

  // ── 6. Sales sheet alignment check ────────────────────────────────────────
  // ENTRY BM formulas read the hidden Sales sheet via INDIRECT/SUMIFS on Sales!$1:$1.
  // Alignment requires:
  //   (a) Sales date-row starts at the same column offset as written (S_DATE_START = F = col 6).
  //   (b) Sales has enough date columns for the full dayCount.
  //   (c) First date written into Sales!F1 matches the export fromDate.
  //   (d) Item name column in Sales (col C = S_NAME_COL) matches ENTRY col C (E_NAME_COL).
  //   (e) ENTRY BM formula sample references "Sales!" — confirm the sheet is not renamed.
  if (salesWs) {
    const mismatches: string[] = [];

    // (a) Column offset
    if (S_DATE_START !== 6) {
      mismatches.push(`S_DATE_START=${S_DATE_START} expected 6 (col F); ENTRY BM uses Sales!$1:$1 starting F`);
    }

    // (b) Capacity
    const salesCapacity = salesWs.columnCount - S_DATE_START + 1;
    if (dayCount > salesCapacity) {
      mismatches.push(`capacity: export=${dayCount} days, Sales only has ${salesCapacity} date columns (F1 onward)`);
    }

    // (c) First date cell in Sales row 1 vs fromDate
    const firstDateCell = salesWs.getRow(S_DATE_ROW).getCell(S_DATE_START);
    const firstDateVal = firstDateCell.value;
    const firstDateWritten =
      firstDateVal instanceof Date
        ? firstDateVal.toISOString().slice(0, 10)
        : typeof firstDateVal === "string"
          ? firstDateVal.slice(0, 10)
          : null;
    if (firstDateWritten && firstDateWritten !== fromDate) {
      mismatches.push(
        `Sales!F1 date="${firstDateWritten}" does not match fromDate="${fromDate}"; ` +
          `SUMIFS date range will be offset`
      );
    }

    // (d) Name column alignment
    if (S_NAME_COL !== E_NAME_COL) {
      mismatches.push(
        `name column mismatch: Sales uses col ${S_NAME_COL}, ENTRY uses col ${E_NAME_COL}; ` +
          `item lookup by row reference may fail`
      );
    }

    // (e) Verify a sample ENTRY BM formula actually references "Sales!"
    const bmColIdx = 65; // BM = column 65
    let bmFormulaChecked = false;
    for (let r = E_DATA_START; r <= Math.min(E_DATA_START + 5, E_DATA_END); r++) {
      const bmCell = entryWs.getRow(r).getCell(bmColIdx);
      const fmla = cellFormula(bmCell.value);
      if (fmla) {
        if (!fmla.includes("Sales!")) {
          mismatches.push(
            `ENTRY!BM${r} formula "${fmla}" does not reference "Sales!" — ` +
              `sheet may have been renamed or formula structure changed`
          );
        }
        bmFormulaChecked = true;
        break;
      }
    }
    if (!bmFormulaChecked) {
      mismatches.push(
        `No BM formula found in ENTRY rows ${E_DATA_START}–${E_DATA_START + 5}; template may be missing Avg Monthly Sales column`
      );
    }

    if (mismatches.length > 0) {
      logger.warn(
        `[spSalesFormExport] Sales alignment issues (${mismatches.length}):\n` +
          mismatches.map((m, i) => `  ${i + 1}. ${m}`).join("\n")
      );
    } else {
      logger.info(
        `[spSalesFormExport] Sales alignment OK — ${dayCount} day(s), F1=${firstDateWritten ?? fromDate}, BM formula references Sales!`
      );
    }
  }

  // ── 7. Output ─────────────────────────────────────────────────────────────
  // This workbook is filled from a positional Excel template. The imported
  // template owns all formula ranges, print settings and sheet protection.
  // Workbook-level branding only: do not change any worksheet contract.
  styleSpecializedWorkbook(wb);
  const rawBuf = await wb.xlsx.writeBuffer();
  const buf = Buffer.from(new Uint8Array(rawBuf));

  // ── 8. Post-export formula error scan ─────────────────────────────────────
  // Re-read the generated buffer and scan every cell result for Excel error strings.
  // If any critical sheet contains errors, fail loudly instead of sending a broken file.
  try {
    const wbCheck = new ExcelJS.Workbook();
    await wbCheck.xlsx.load(toArrayBuffer(buf));
    const errorsBySheet: Record<string, string[]> = {};
    for (const ws of wbCheck.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          // Text results only: an error cached as `{ error: "#DIV/0!" }` is not
          // text and is missed here — see `cellResultText`.
          const result = cellResultText(cell.value);
          if (result !== null && EXCEL_ERRORS.some((e) => result.includes(e))) {
            (errorsBySheet[ws.name] ??= []).push(`${ws.name}!${cell.address}: ${result}`);
          }
        });
      });
    }

    const allErrors = Object.entries(errorsBySheet).flatMap(([, errs]) => errs);
    if (allErrors.length > 0) {
      logger.warn(`[spSalesFormExport] Formula errors detected (all sheets):`, { errors: allErrors });
    }

    // NOTE: ExcelJS reads cached formula results embedded at write-time; it does not
    // recalculate.  This catches errors baked into the template cache or explicitly
    // written as result values.  Errors that only appear after Excel recalculates on
    // open cannot be detected here — but cached errors always indicate a real problem
    // (broken template cell, bad opening-stock write, missing data, etc.) so we fail.
    const criticalSheets = ["ENTRY", "Costing", "Summary", "Ageing", "Summary-Itemwise"];
    const criticalErrors = criticalSheets.flatMap((s) => errorsBySheet[s] ?? []);
    if (criticalErrors.length > 0) {
      throw new Error(
        `SP Sales Form export aborted — formula errors in critical sheets:\n` + criticalErrors.slice(0, 20).join("\n")
      );
    }
  } catch (scanErr: unknown) {
    // Re-throw export-abort errors; swallow scan infrastructure failures only.
    if (getErrorMessage(scanErr)?.startsWith("SP Sales Form export aborted")) throw scanErr;
    logger.error("[spSalesFormExport] Error scan failed (non-critical):", { error: getErrorMessage(scanErr) });
  }
  return { buf };
}
