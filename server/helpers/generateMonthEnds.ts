// Extracted from ./generateNetPositionExcel.ts to keep that module under the source-size cap.
import ExcelJS from "exceljs";
import { calculateNetPositionAsOf, NetPositionLineItem } from "./calculateNetPositionAsOf";
import { calculateIncomeStatementForPeriod, IncomeStatement } from "./calculateIncomeStatementForPeriod";
import { round2 } from "../netPositionHelper";

// ─── date helpers ─────────────────────────────────────────────────────────────

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month + 1, 0));
  return d.toISOString().split("T")[0];
}

function addOneDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

export function fmtMonthLabel(dateStr: string): string {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [yr, mo] = dateStr.split("-");
  return `${names[parseInt(mo) - 1]} ${yr}`;
}

export function fmtSheetName(dateStr: string): string {
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [yr, mo] = dateStr.split("-");
  return `${names[parseInt(mo) - 1]} ${yr}`;
}

export function generateMonthEnds(startDate: string, endDate: string): string[] {
  const ends: string[] = [];
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  while (true) {
    const candidate = lastDayOfMonth(year, month);
    const candidateDate = new Date(candidate + "T00:00:00Z");
    if (candidateDate <= end) {
      ends.push(candidate);
    } else {
      if (new Date(`${year}-${String(month + 1).padStart(2, "0")}-01T00:00:00Z`) <= end) {
        ends.push(endDate);
      }
      break;
    }
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
    if (year > 2100) break;
  }
  return ends;
}

// ─── palette ──────────────────────────────────────────────────────────────────

export const C = {
  DARK_BLUE: "FF1E3A5F",
  MID_BLUE: "FF2D5F8A",
  GREEN: "FF16A34A",
  RED: "FFDC2626",
  GREEN_BG: "FFD1FAE5",
  RED_BG: "FFFEE2E2",
  YELLOW_BG: "FFFEF9C3",
  AMBER_BG: "FFFEF3C7",
  GRAY_BG: "FFF3F4F6",
  GRAY_HD: "FFE5E7EB",
  WHITE: "FFFFFFFF",
  LIGHT_BLUE: "FFE0EAF5",
  MUTED: "FF6B7280",
};

export const currencyFmt = "#,##0.00";

export const signedFmt = '+#,##0.00;-#,##0.00;"-"';

export function styleHeader(cell: ExcelJS.Cell, bgArgb = C.DARK_BLUE) {
  cell.font = { bold: true, color: { argb: C.WHITE }, size: 11 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = { bottom: { style: "thin", color: { argb: "FFAAAAAA" } } };
}

export function styleTitle(cell: ExcelJS.Cell, text: string, fontSize = 16) {
  cell.value = text;
  cell.font = { bold: true, size: fontSize, color: { argb: C.WHITE } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.DARK_BLUE } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
}

export function setThin(cell: ExcelJS.Cell) {
  cell.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } };
}

export function lineKey(item: NetPositionLineItem) {
  return `${item.side}::${item.label}`;
}

export async function generateNetPositionExcelStep1(
  companyId: number,
  companyName: string,
  startDate: string,
  endDate: string
) {
  const monthEnds = generateMonthEnds(startDate, endDate);
  if (monthEnds.length === 0) throw new Error("No months in range");

  type Snapshot = Awaited<ReturnType<typeof calculateNetPositionAsOf>> & {
    dateStr: string;
    label: string;
    change: number | null;
    periodFrom: string;
    income: IncomeStatement;
  };

  const snapshots: Snapshot[] = [];
  let prevNet: number | null = null;
  let prevDate: string | null = null;

  for (const dateStr of monthEnds) {
    const periodFrom = prevDate ? addOneDay(prevDate) : startDate;
    const [snap, income] = await Promise.all([
      calculateNetPositionAsOf(companyId, dateStr),
      calculateIncomeStatementForPeriod(companyId, periodFrom, dateStr),
    ]);
    const change = prevNet !== null ? round2(snap.netPosition - prevNet) : null;
    snapshots.push({ ...snap, dateStr, label: fmtMonthLabel(dateStr), change, periodFrom, income });
    prevNet = snap.netPosition;
    prevDate = dateStr;
  }

  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.default.Workbook();
  wb.creator = "ERP System";
  wb.created = new Date();

  // ═══════════════════════════════════════════════════════════════════
  //  SHEET 1: Overview
  // ═══════════════════════════════════════════════════════════════════
  const wsOv = wb.addWorksheet("Overview");

  // Title
  wsOv.mergeCells("A1:E1");
  styleTitle(wsOv.getCell("A1"), `Net Position Overview — ${companyName}`, 16);
  wsOv.getRow(1).height = 40;

  wsOv.mergeCells("A2:E2");
  const ovSub = wsOv.getCell("A2");
  ovSub.value = `Period: ${startDate}  →  ${endDate}   |   Historical base currency: USD   |   Rate convention: TRANSACTION_PER_BASE`;
  ovSub.font = { italic: true, size: 10, color: { argb: C.MUTED } };
  ovSub.alignment = { horizontal: "center" };
  wsOv.getRow(2).height = 18;

  wsOv.addRow([]);

  // ── Most-recent position KPI box ─────────────────────────────────
  const lastSnap = snapshots[snapshots.length - 1];
  const isFinalPos = lastSnap.netPosition >= 0;

  wsOv.mergeCells("A4:E4");
  const kpiTitle = wsOv.getCell("A4");
  kpiTitle.value = `Current Position  (as of ${lastSnap.dateStr})`;
  kpiTitle.font = { bold: true, size: 12, color: { argb: C.WHITE } };
  kpiTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.MID_BLUE } };
  kpiTitle.alignment = { horizontal: "center", vertical: "middle" };
  wsOv.getRow(4).height = 26;

  const kpiHdrRow = wsOv.addRow(["Money Owed TO US", "", "Money WE OWE", "", "Net Position"]);
  kpiHdrRow.height = 22;
  const hdrRowNum = kpiHdrRow.number;
  wsOv.mergeCells(hdrRowNum, 1, hdrRowNum, 2);
  wsOv.mergeCells(hdrRowNum, 3, hdrRowNum, 4);
  [1, 3, 5].forEach((col) => {
    const cell = kpiHdrRow.getCell(col);
    cell.font = { bold: true, color: { argb: C.WHITE }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.DARK_BLUE } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });

  const kpiValRow = wsOv.addRow([lastSnap.forUsTotal, "", lastSnap.onUsTotal, "", Math.abs(lastSnap.netPosition)]);
  kpiValRow.height = 36;
  const valRowNum = kpiValRow.number;
  wsOv.mergeCells(valRowNum, 1, valRowNum, 2);
  wsOv.mergeCells(valRowNum, 3, valRowNum, 4);
  [
    [1, C.GREEN],
    [3, C.RED],
    [5, isFinalPos ? C.GREEN : C.RED],
  ].forEach(([col, color]) => {
    const cell = kpiValRow.getCell(col as number);
    cell.numFmt = currencyFmt;
    cell.font = { bold: true, size: 16, color: { argb: color as string } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.LIGHT_BLUE } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = { bottom: { style: "medium", color: { argb: C.DARK_BLUE } } };
  });

  const statusRow = wsOv.addRow(["", "", "", "", lastSnap.netPositionLabel]);
  statusRow.height = 22;
  const stRowNum = statusRow.number;
  wsOv.mergeCells(stRowNum, 1, stRowNum, 2);
  wsOv.mergeCells(stRowNum, 3, stRowNum, 4);
  const stCell = statusRow.getCell(5);
  stCell.font = { bold: true, size: 12, color: { argb: isFinalPos ? C.GREEN : C.RED } };
  stCell.alignment = { horizontal: "center" };
  stCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.LIGHT_BLUE } };

  wsOv.addRow([]);

  // ── Monthly trend table ───────────────────────────────────────────
  wsOv.mergeCells("A9:E9");
  const trendTitle = wsOv.getCell("A9");
  trendTitle.value = "Monthly Trend";
  trendTitle.font = { bold: true, size: 11, color: { argb: C.WHITE } };
  trendTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.MID_BLUE } };
  trendTitle.alignment = { horizontal: "center", vertical: "middle" };
  wsOv.getRow(9).height = 24;

  const trendHdr = wsOv.addRow(["Month", "Money Owed TO US", "Money WE OWE", "Net Position", "Status"]);
  trendHdr.height = 22;
  trendHdr.eachCell((cell) => styleHeader(cell));

  for (const s of snapshots) {
    const isPos = s.netPosition >= 0;
    const dr = wsOv.addRow([s.label, s.forUsTotal, s.onUsTotal, Math.abs(s.netPosition), s.netPositionLabel]);
    dr.getCell(1).font = { bold: true };
    dr.getCell(2).numFmt = currencyFmt;
    dr.getCell(2).font = { color: { argb: C.GREEN } };
    dr.getCell(3).numFmt = currencyFmt;
    dr.getCell(3).font = { color: { argb: C.RED } };
    dr.getCell(4).numFmt = currencyFmt;
    dr.getCell(4).font = { bold: true, color: { argb: isPos ? C.GREEN : C.RED } };
    dr.getCell(5).font = { bold: true, color: { argb: isPos ? C.GREEN : C.RED } };
    dr.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: isPos ? C.GREEN_BG : C.RED_BG } };
      setThin(cell);
    });
  }

  // Column widths
  [22, 24, 24, 22, 18].forEach((w, i) => {
    wsOv.getColumn(i + 1).width = w;
  });

  // ═══════════════════════════════════════════════════════════════════
  //  SHEET 2: Income
  // ═══════════════════════════════════════════════════════════════════
  const wsInc = wb.addWorksheet("Income");

  wsInc.mergeCells("A1:D1");
  styleTitle(wsInc.getCell("A1"), `Monthly Income Statement — ${companyName}`, 14);
  wsInc.getRow(1).height = 36;

  wsInc.mergeCells("A2:D2");
  const incSub = wsInc.getCell("A2");
  incSub.value = `Period: ${startDate}  →  ${endDate}   |   Historical base currency: USD   |   Rate convention: TRANSACTION_PER_BASE`;
  incSub.font = { italic: true, size: 10, color: { argb: C.MUTED } };
  incSub.alignment = { horizontal: "center" };
  wsInc.getRow(2).height = 18;

  wsInc.addRow([]);

  // Summary table header
  const incHdr = wsInc.addRow(["Month", "Revenue", "Total Expenses", "Net Income"]);
  incHdr.height = 22;
  incHdr.eachCell((cell) => styleHeader(cell));

  for (const s of snapshots) {
    const netIncome = round2(s.income.totalRevenue - s.income.totalExpenses);
    const isProfit = netIncome >= 0;
    const dr = wsInc.addRow([s.label, s.income.totalRevenue, s.income.totalExpenses, Math.abs(netIncome)]);
    dr.getCell(1).font = { bold: true };
    dr.getCell(2).numFmt = currencyFmt;
    dr.getCell(2).font = { color: { argb: C.GREEN } };
    dr.getCell(3).numFmt = currencyFmt;
    dr.getCell(3).font = { color: { argb: C.RED } };
    dr.getCell(4).numFmt = currencyFmt;
    dr.getCell(4).font = { bold: true, color: { argb: isProfit ? C.GREEN : C.RED } };
    dr.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: isProfit ? C.GREEN_BG : C.RED_BG } };
      setThin(cell);
    });
  }

  // Totals row
  const totalRevenue = round2(snapshots.reduce((s, x) => s + x.income.totalRevenue, 0));
  const totalExpenses = round2(snapshots.reduce((s, x) => s + x.income.totalExpenses, 0));
  const totalNetInc = round2(totalRevenue - totalExpenses);
  const isTotProfit = totalNetInc >= 0;

  wsInc.addRow([]);
  const incTotRow = wsInc.addRow(["Total (Period)", totalRevenue, totalExpenses, Math.abs(totalNetInc)]);
  incTotRow.height = 24;
  incTotRow.getCell(1).font = { bold: true, size: 11 };
  [2, 3, 4].forEach((i) => {
    incTotRow.getCell(i).numFmt = currencyFmt;
  });
  incTotRow.getCell(2).font = { bold: true, color: { argb: C.GREEN } };
  incTotRow.getCell(3).font = { bold: true, color: { argb: C.RED } };
  incTotRow.getCell(4).font = { bold: true, size: 12, color: { argb: isTotProfit ? C.GREEN : C.RED } };
  incTotRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: isTotProfit ? "FFB3F5D3" : "FFFDCFCF" } };
    cell.border = {
      top: { style: "medium", color: { argb: C.DARK_BLUE } },
      bottom: { style: "medium", color: { argb: C.DARK_BLUE } },
    };
  });

  wsInc.addRow([]);
  wsInc.addRow([]);
  return { snapshots, wb, wsInc };
}
