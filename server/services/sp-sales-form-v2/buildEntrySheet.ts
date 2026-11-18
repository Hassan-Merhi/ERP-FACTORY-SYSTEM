import ExcelJS from "exceljs";
import { ItemRow, SpSalesFormV2Params } from "./types";
import { colLetter } from "./dateHelpers";
import {
  fill,
  boldSm,
  normSm,
  thin,
  right,
  leftAl,
  DARK_BLUE,
  GREEN_HDR,
  BRIGHT_YLW,
  WHITE,
  BANK_GRN,
  MONEY_FMT,
  COL_ROWNUM,
  COL_ITEMCODE,
  COLS_PER_DAY,
} from "./constants";
import { buildEntrySheetStep1 } from "./buildEntrySheetStep1";
import { buildEntrySheetStep2 } from "./buildEntrySheetStep2";

export async function buildEntrySheet(
  wb: ExcelJS.Workbook,
  items: ItemRow[],
  dates: string[],
  dayCount: number,
  params: SpSalesFormV2Params,
  openingCashBalance: number | null // null = no account selected (manual input on day 0)
): Promise<void> {
  const {
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
  } = buildEntrySheetStep1(wb, items, dates, dayCount, params);
  const { NUM_PAYMENT_ROWS, balanceRow, payFirst, payLast, totalPayRow } = buildEntrySheetStep2(
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
    },
    items,
    dates,
    dayCount,
    openingCashBalance
  );
  await buildEntrySheetStep3(
    {
      NUM_PAYMENT_ROWS,
      balanceRow,
      dayBase,
      depositRow,
      openCashRow,
      payFirst,
      payLast,
      paymentsHdrRow,
      receiptRow,
      totalPayRow,
      totalRowNum,
      ws,
    },
    dayCount
  );
}

async function buildEntrySheetStep3(
  {
    NUM_PAYMENT_ROWS,
    balanceRow,
    dayBase,
    depositRow,
    openCashRow,
    payFirst,
    payLast,
    paymentsHdrRow,
    receiptRow,
    totalPayRow,
    totalRowNum,
    ws,
  }: Pick<
    Awaited<ReturnType<typeof buildEntrySheetStep1>> & Awaited<ReturnType<typeof buildEntrySheetStep2>>,
    | "NUM_PAYMENT_ROWS"
    | "balanceRow"
    | "dayBase"
    | "depositRow"
    | "openCashRow"
    | "payFirst"
    | "payLast"
    | "paymentsHdrRow"
    | "receiptRow"
    | "totalPayRow"
    | "totalRowNum"
    | "ws"
  >,
  dayCount: number
) {
  // Payment rows 1 – NUM_PAYMENT_ROWS (unlocked input)
  for (let p = 1; p <= NUM_PAYMENT_ROWS; p++) {
    const pr = paymentsHdrRow + p;
    ws.getRow(pr).height = 13;
    ws.mergeCells(pr, COL_ROWNUM, pr, COL_ITEMCODE);
    const lbl = ws.getCell(pr, 1);
    lbl.value = `Payment ${p}`;
    lbl.font = normSm;
    lbl.fill = fill(WHITE);
    lbl.border = thin;
    lbl.alignment = leftAl;
    lbl.protection = { locked: true };
    for (let d = 0; d < dayCount; d++) {
      const b = dayBase + d * COLS_PER_DAY;
      const cashC = ws.getCell(pr, b);
      cashC.value = null;
      cashC.numFmt = MONEY_FMT;
      cashC.fill = fill(BRIGHT_YLW);
      cashC.border = thin;
      cashC.alignment = right;
      cashC.protection = { locked: false };
      const bankC = ws.getCell(pr, b + 1);
      bankC.value = null;
      bankC.numFmt = MONEY_FMT;
      bankC.fill = fill(BANK_GRN);
      bankC.border = thin;
      bankC.alignment = right;
      bankC.protection = { locked: false };
    }
  }

  // ── Total Payments row (locked SUM formulas) ──────────────────────────────────
  ws.getRow(totalPayRow).height = 14;
  ws.mergeCells(totalPayRow, COL_ROWNUM, totalPayRow, COL_ITEMCODE);
  const tpLbl = ws.getCell(totalPayRow, COL_ROWNUM);
  tpLbl.value = "Total Payments";
  tpLbl.font = { ...boldSm, color: { argb: WHITE } };
  tpLbl.fill = fill(DARK_BLUE);
  tpLbl.border = thin;
  tpLbl.alignment = leftAl;
  tpLbl.protection = { locked: true };
  for (let d = 0; d < dayCount; d++) {
    const b = dayBase + d * COLS_PER_DAY;
    const cL = colLetter(b),
      bL = colLetter(b + 1);
    const cashC = ws.getCell(totalPayRow, b);
    cashC.value = { formula: `SUM(${cL}${payFirst}:${cL}${payLast})`, result: 0 } as ExcelJS.CellValue;
    cashC.numFmt = MONEY_FMT;
    cashC.fill = fill(DARK_BLUE);
    cashC.border = thin;
    cashC.alignment = right;
    cashC.font = { ...boldSm, color: { argb: WHITE } };
    cashC.protection = { locked: true };
    const bankC = ws.getCell(totalPayRow, b + 1);
    bankC.value = { formula: `SUM(${bL}${payFirst}:${bL}${payLast})`, result: 0 } as ExcelJS.CellValue;
    bankC.numFmt = MONEY_FMT;
    bankC.fill = fill(DARK_BLUE);
    bankC.border = thin;
    bankC.alignment = right;
    bankC.font = { ...boldSm, color: { argb: WHITE } };
    bankC.protection = { locked: true };
  }

  // ── Balance Cash row (locked formulas) ────────────────────────────────────────
  //   Cash  = OpeningCash + DailyTotalSales − CashDeposit + ReceiptFromCredit − TotalCashPayments
  //   Bank  = OpeningBank + BankDeposit     − TotalBankPayments
  //   Note  : DailyTotalSales is the TOTAL row's Sales column (same letter as BANK col,
  //           but referenced at totalRowNum — not the cash-section bank col).
  ws.getRow(balanceRow).height = 14;
  ws.mergeCells(balanceRow, COL_ROWNUM, balanceRow, COL_ITEMCODE);
  const balLbl = ws.getCell(balanceRow, COL_ROWNUM);
  balLbl.value = "Balance Cash";
  balLbl.font = { ...boldSm, color: { argb: WHITE } };
  balLbl.fill = fill(GREEN_HDR);
  balLbl.border = thin;
  balLbl.alignment = leftAl;
  balLbl.protection = { locked: true };
  for (let d = 0; d < dayCount; d++) {
    const b = dayBase + d * COLS_PER_DAY;
    const cL = colLetter(b),
      bL = colLetter(b + 1);
    // cL = CASH column; bL = BANK column (= same column as Total Sales in item/TOTAL rows)
    const cashC = ws.getCell(balanceRow, b);
    cashC.value = {
      formula: `${cL}${openCashRow}+${bL}${totalRowNum}-${cL}${depositRow}+${cL}${receiptRow}-${cL}${totalPayRow}`,
      result: 0,
    } as ExcelJS.CellValue;
    cashC.numFmt = MONEY_FMT;
    cashC.fill = fill(GREEN_HDR);
    cashC.border = thin;
    cashC.alignment = right;
    cashC.font = { ...boldSm, color: { argb: WHITE } };
    cashC.protection = { locked: true };
    const bankC = ws.getCell(balanceRow, b + 1);
    bankC.value = {
      formula: `${bL}${openCashRow}+${bL}${depositRow}-${bL}${totalPayRow}`,
      result: 0,
    } as ExcelJS.CellValue;
    bankC.numFmt = MONEY_FMT;
    bankC.fill = fill(GREEN_HDR);
    bankC.border = thin;
    bankC.alignment = right;
    bankC.font = { ...boldSm, color: { argb: WHITE } };
    bankC.protection = { locked: true };
  }

  // ── Protect sheet (allow filter, lock all except unlocked cells above) ───────
  await ws.protect("", {
    selectLockedCells: true,
    selectUnlockedCells: true,
    autoFilter: true,
  });
  return {};
}
