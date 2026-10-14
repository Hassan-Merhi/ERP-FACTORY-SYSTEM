import ExcelJS from "exceljs";

// ── Style constants ───────────────────────────────────────────────────────────
export const DARK_BLUE   = "FF1F3864";
export const MID_BLUE    = "FF2F5597";
export const ORANGE_HDR  = "FFFF9900";
export const GREEN_HDR   = "FF70AD47";
export const YELLOW_GRP  = "FFFFFF2C";  // group column / subtotal rows
export const PURPLE_QTY  = "FFD9D2FF";  // qty columns
export const BRIGHT_YLW  = "FFFFD966";  // sale price columns
export const OPEN_BLUE   = "FFDAE8F5";  // opening stock columns
export const CLOSE_GRN   = "FFD5E8D4";  // closing stock columns
export const TOTALS_ORG  = "FFFFBF00";  // avg monthly
export const ALT_ROW     = "FFF8F8F8";
export const WHITE       = "FFFFFFFF";
export const CASH_PINK   = "FFFFD9FF";  // CASH sub-header
export const BANK_GRN    = "FFD9FFD9";  // BANK sub-header

export const boldSm: Partial<ExcelJS.Font> = { bold: true, size: 9 };
export const normSm: Partial<ExcelJS.Font> = { size: 9 };
export const thin: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFD0D0D0" } },
  bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
  left:   { style: "thin", color: { argb: "FFD0D0D0" } },
  right:  { style: "thin", color: { argb: "FFD0D0D0" } },
};
export const ctr: Partial<ExcelJS.Alignment> = { horizontal: "center", vertical: "middle" };
export const right: Partial<ExcelJS.Alignment> = { horizontal: "right", vertical: "middle" };
export const leftAl: Partial<ExcelJS.Alignment> = { horizontal: "left", vertical: "middle" };
export const NUM = "#,##0.00";            // kept for Costing / Summary sheets
export const NUM4 = "#,##0.0000";         // kept for Costing / Summary sheets
export const QTY_FMT   = "#,##0";        // ENTRY — quantities, whole units only
export const MONEY_FMT  = '"$"#,##0';    // ENTRY — monetary values, whole dollars (no .00)

export function fill(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}
export function wFont(sz = 10): Partial<ExcelJS.Font> { return { color: { argb: WHITE }, bold: true, size: sz }; }

// ── Excel error scanner tokens ────────────────────────────────────────────────
export const EXCEL_ERRORS = ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"];

// ── ENTRY sheet layout ────────────────────────────────────────────────────────
// A=RowNum, B=Group, C=Item Name, D=Item Code, E=Opening Qty, F=Cost/Bag
export const COL_ROWNUM    = 1;
export const COL_GROUP     = 2;
export const COL_ITEMNAME  = 3;
export const COL_ITEMCODE  = 4;
export const COL_OPENQTY   = 5;
export const COL_COSTBAG   = 6;
export const FIXED_LEFT   = COL_COSTBAG;  // = 6
export const COLS_PER_DAY = 3;  // Qty, SalePrice, Profit/Bag
export const AFTER_DATES  = 3;  // CloseQty, CloseVal, AvgMonthlySales
