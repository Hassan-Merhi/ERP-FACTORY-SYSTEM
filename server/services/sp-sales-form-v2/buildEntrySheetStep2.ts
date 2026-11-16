// Extracted from ./buildEntrySheet.ts to keep that module under the source-size cap.
import ExcelJS from "exceljs";
import { ItemRow } from "./types";
import { colLetter } from "./dateHelpers";
import { applyCell, r2 } from "./styleHelpers";
import {
  BANK_GRN,
  boldSm,
  BRIGHT_YLW,
  CASH_PINK,
  COL_ITEMCODE,
  COL_OPENQTY,
  COL_ROWNUM,
  COLS_PER_DAY,
  ctr,
  DARK_BLUE,
  fill,
  GREEN_HDR,
  leftAl,
  MONEY_FMT,
  QTY_FMT,
  right,
  thin,
  wFont,
  WHITE,
} from "./constants";
import { buildEntrySheetStep1 } from "./buildEntrySheetStep1";

export function buildEntrySheetStep2(
  {
    cashHdrRow,
    cashSubHdrRow,
    closeQtyCol,
    dayBase,
    depositRow,
    openCashRow,
    paymentsHdrRow,
    receiptRow,
    subtotalRowNums,
    totalCols,
    totalRowNum,
    ws,
  }: Pick<
    Awaited<ReturnType<typeof buildEntrySheetStep1>>,
    | "cashHdrRow"
    | "cashSubHdrRow"
    | "closeQtyCol"
    | "dayBase"
    | "depositRow"
    | "openCashRow"
    | "paymentsHdrRow"
    | "receiptRow"
    | "subtotalRowNums"
    | "totalCols"
    | "totalRowNum"
    | "ws"
  >,
  items: ItemRow[],
  dates: string[],
  dayCount: number,
  openingCashBalance: number | null
) {
  // ════════ Grand TOTAL row (green) ════════════════════════════════════════════
  ws.getRow(totalRowNum).height = 16;
  for (let col = 1; col <= totalCols; col++) {
    const c = ws.getCell(totalRowNum, col);
    c.fill = fill(GREEN_HDR);
    c.font = { ...boldSm, color: { argb: WHITE } };
    c.border = thin;
    c.alignment = right;
    c.protection = { locked: true };
  }
  ws.mergeCells(totalRowNum, COL_ROWNUM, totalRowNum, COL_ITEMCODE); // A-D (incl. Group column)
  const totLbl = ws.getCell(totalRowNum, COL_ROWNUM);
  totLbl.value = "TOTAL";
  totLbl.fill = fill(GREEN_HDR);
  totLbl.font = wFont();
  totLbl.alignment = ctr;

  if (items.length > 0) {
    const stNumRefs = (col: number) => subtotalRowNums.map((sr) => `${colLetter(col)}${sr}`).join(",");

    // Opening Qty (col E)
    ws.getCell(totalRowNum, COL_OPENQTY).value = {
      formula: `SUM(${stNumRefs(COL_OPENQTY)})`,
      result: Math.round(items.reduce((s, i) => s + i.openQty, 0)),
    } as ExcelJS.CellValue;
    ws.getCell(totalRowNum, COL_OPENQTY).numFmt = QTY_FMT;
    ws.getCell(totalRowNum, COL_OPENQTY).font = { ...boldSm, color: { argb: WHITE } };

    // Per-day grand totals (SUM of category subtotal rows so they cascade from live formulas)
    for (let d = 0; d < dayCount; d++) {
      const b = dayBase + d * COLS_PER_DAY;
      const qtyTot = Math.round(items.reduce((s, i) => s + (i.salesByDate.get(dates[d])?.qty ?? 0), 0));
      const salTot = r2(
        items.reduce((s, i) => {
          const ds = i.salesByDate.get(dates[d]);
          return s + (ds?.totalSales ?? 0) - (ds?.totalDeduction ?? 0);
        }, 0)
      );
      const profTot = r2(
        items.reduce((s, i) => {
          const ds = i.salesByDate.get(dates[d]);
          return s + (ds?.totalSales ?? 0) - (ds?.totalDeduction ?? 0) - (ds?.totalCost ?? 0);
        }, 0)
      );

      ws.getCell(totalRowNum, b).value = { formula: `SUM(${stNumRefs(b)})`, result: qtyTot } as ExcelJS.CellValue;
      ws.getCell(totalRowNum, b).numFmt = QTY_FMT;
      ws.getCell(totalRowNum, b).font = { ...boldSm, color: { argb: WHITE } };

      ws.getCell(totalRowNum, b + 1).value = {
        formula: `SUM(${stNumRefs(b + 1)})`,
        result: salTot || 0,
      } as ExcelJS.CellValue;
      ws.getCell(totalRowNum, b + 1).numFmt = MONEY_FMT;
      ws.getCell(totalRowNum, b + 1).font = { ...boldSm, color: { argb: WHITE } };

      ws.getCell(totalRowNum, b + 2).value = {
        formula: `SUM(${stNumRefs(b + 2)})`,
        result: profTot || 0,
      } as ExcelJS.CellValue;
      ws.getCell(totalRowNum, b + 2).numFmt = MONEY_FMT;
      ws.getCell(totalRowNum, b + 2).font = { ...boldSm, color: { argb: WHITE } };
    }

    // Closing totals (can be negative — no clamping)
    ws.getCell(totalRowNum, closeQtyCol).value = {
      formula: `SUM(${stNumRefs(closeQtyCol)})`,
      result: Math.round(items.reduce((s, i) => s + i.closeQty, 0)),
    } as ExcelJS.CellValue;
    ws.getCell(totalRowNum, closeQtyCol).numFmt = QTY_FMT;
    ws.getCell(totalRowNum, closeQtyCol).font = { ...boldSm, color: { argb: WHITE } };

    ws.getCell(totalRowNum, closeQtyCol + 1).value = {
      formula: `SUM(${stNumRefs(closeQtyCol + 1)})`,
      result: r2(items.reduce((s, i) => s + i.closeValue, 0)),
    } as ExcelJS.CellValue;
    ws.getCell(totalRowNum, closeQtyCol + 1).numFmt = MONEY_FMT;
    ws.getCell(totalRowNum, closeQtyCol + 1).font = { ...boldSm, color: { argb: WHITE } };
  }

  // ════════ Cash & Bank section ════════════════════════════════════════════════

  const NUM_PAYMENT_ROWS = 10;
  const payFirst = paymentsHdrRow + 1;
  const payLast = paymentsHdrRow + NUM_PAYMENT_ROWS;
  const totalPayRow = payLast + 1;
  const balanceRow = totalPayRow + 1;

  // Helper: write label cell (A-D merged, incl. Group column) for a cash-section row
  const setCashLabel = (row: number, label: string, bgColor: string, textColor?: string) => {
    ws.getRow(row).height = 13;
    ws.mergeCells(row, COL_ROWNUM, row, COL_ITEMCODE);
    const lbl = ws.getCell(row, 1);
    lbl.value = label;
    lbl.font = textColor ? { ...boldSm, color: { argb: textColor } } : boldSm;
    lbl.fill = fill(bgColor);
    lbl.border = thin;
    lbl.alignment = leftAl;
    lbl.protection = { locked: true };
  };

  // Section header
  ws.getRow(cashHdrRow).height = 16;
  ws.mergeCells(cashHdrRow, 1, cashHdrRow, totalCols);
  applyCell(ws, cashHdrRow, 1, "CASH & BANK SUMMARY", fill(DARK_BLUE), wFont(), ctr);

  // CASH / BANK sub-headers per day
  ws.getRow(cashSubHdrRow).height = 13;
  ws.mergeCells(cashSubHdrRow, COL_ROWNUM, cashSubHdrRow, COL_ITEMCODE);
  ws.getCell(cashSubHdrRow, COL_ROWNUM).border = thin;
  for (let d = 0; d < dayCount; d++) {
    const b = dayBase + d * COLS_PER_DAY;
    const cashC = ws.getCell(cashSubHdrRow, b);
    cashC.value = "CASH";
    cashC.fill = fill(CASH_PINK);
    cashC.font = boldSm;
    cashC.alignment = ctr;
    cashC.border = thin;
    cashC.protection = { locked: true };
    const bankC = ws.getCell(cashSubHdrRow, b + 1);
    bankC.value = "BANK";
    bankC.fill = fill(BANK_GRN);
    bankC.font = boldSm;
    bankC.alignment = ctr;
    bankC.border = thin;
    bankC.protection = { locked: true };
  }

  // ── Opening Cash row ──────────────────────────────────────────────────────────
  setCashLabel(openCashRow, "Opening Cash", WHITE);
  for (let d = 0; d < dayCount; d++) {
    const b = dayBase + d * COLS_PER_DAY;
    const cashC = ws.getCell(openCashRow, b);
    cashC.numFmt = MONEY_FMT;
    cashC.fill = fill(CASH_PINK);
    cashC.border = thin;
    cashC.alignment = right;
    cashC.font = boldSm;
    const bankC = ws.getCell(openCashRow, b + 1);
    bankC.numFmt = MONEY_FMT;
    bankC.fill = fill(BANK_GRN);
    bankC.border = thin;
    bankC.alignment = right;
    bankC.font = boldSm;
    if (d === 0) {
      // First day: account balance or blank manual input
      cashC.value = openingCashBalance !== null ? openingCashBalance : null;
      cashC.protection = { locked: openingCashBalance !== null };
      bankC.value = null;
      bankC.protection = { locked: false };
    } else {
      // Subsequent days: link to previous day Balance Cash
      const prevCL = colLetter(dayBase + (d - 1) * COLS_PER_DAY);
      const prevBL = colLetter(dayBase + (d - 1) * COLS_PER_DAY + 1);
      cashC.value = { formula: `${prevCL}${balanceRow}`, result: null } as unknown as {
        formula: string;
        result: null;
      } & ExcelJS.CellValue;
      cashC.protection = { locked: true };
      bankC.value = { formula: `${prevBL}${balanceRow}`, result: null } as unknown as {
        formula: string;
        result: null;
      } & ExcelJS.CellValue;
      bankC.protection = { locked: true };
    }
  }

  // ── Deposit row ───────────────────────────────────────────────────────────────
  //   CASH col: user enters deposit (unlocked)
  //   BANK col: formula mirrors CASH deposit (locked)
  setCashLabel(depositRow, "Cash deposit in Bank (Enter Only in Cash Column)", WHITE, "FFCC0000");
  for (let d = 0; d < dayCount; d++) {
    const b = dayBase + d * COLS_PER_DAY;
    const cL = colLetter(b);
    const cashC = ws.getCell(depositRow, b);
    cashC.value = null;
    cashC.numFmt = MONEY_FMT;
    cashC.fill = fill(CASH_PINK);
    cashC.border = thin;
    cashC.alignment = right;
    cashC.protection = { locked: false };
    const bankC = ws.getCell(depositRow, b + 1);
    bankC.value = { formula: `${cL}${depositRow}`, result: null } as unknown as {
      formula: string;
      result: null;
    } & ExcelJS.CellValue;
    bankC.numFmt = MONEY_FMT;
    bankC.fill = fill(BANK_GRN);
    bankC.border = thin;
    bankC.alignment = right;
    bankC.protection = { locked: true };
  }

  // ── Receipt from Credit Sales row ────────────────────────────────────────────
  //   CASH col: user enters receipt (unlocked)
  //   BANK col: blank / locked
  setCashLabel(receiptRow, "Receipt from Credit Sales", BRIGHT_YLW);
  for (let d = 0; d < dayCount; d++) {
    const b = dayBase + d * COLS_PER_DAY;
    const cashC = ws.getCell(receiptRow, b);
    cashC.value = null;
    cashC.numFmt = MONEY_FMT;
    cashC.fill = fill(BRIGHT_YLW);
    cashC.border = thin;
    cashC.alignment = right;
    cashC.protection = { locked: false };
    const bankC = ws.getCell(receiptRow, b + 1);
    bankC.value = null;
    bankC.numFmt = MONEY_FMT;
    bankC.fill = fill(BANK_GRN);
    bankC.border = thin;
    bankC.alignment = right;
    bankC.protection = { locked: true };
  }

  // ════════ Payments section ════════════════════════════════════════════════════
  ws.getRow(paymentsHdrRow).height = 16;
  ws.mergeCells(paymentsHdrRow, 1, paymentsHdrRow, totalCols);
  applyCell(ws, paymentsHdrRow, 1, "PAYMENTS", fill(DARK_BLUE), wFont(), ctr);
  return { NUM_PAYMENT_ROWS, balanceRow, payFirst, payLast, totalPayRow };
}
