/**
 * Shared helper: builds the net-position monthly Excel workbook buffer.
 * Used by both the HTTP route (streams to browser) and the WhatsApp scheduler.
 */

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

function fmtSheetName(dateStr: string): string {
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

const C = {
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

const currencyFmt = "#,##0.00";
const signedFmt = '+#,##0.00;-#,##0.00;"-"';

function styleHeader(cell: ExcelJS.Cell, bgArgb = C.DARK_BLUE) {
  cell.font = { bold: true, color: { argb: C.WHITE }, size: 11 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = { bottom: { style: "thin", color: { argb: "FFAAAAAA" } } };
}

function styleTitle(cell: ExcelJS.Cell, text: string, fontSize = 16) {
  cell.value = text;
  cell.font = { bold: true, size: fontSize, color: { argb: C.WHITE } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.DARK_BLUE } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
}

function setThin(cell: ExcelJS.Cell) {
  cell.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } };
}

function lineKey(item: NetPositionLineItem) {
  return `${item.side}::${item.label}`;
}

function valueMap(lines: NetPositionLineItem[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(lineKey(l), l.value);
  return m;
}

// ─── main export ──────────────────────────────────────────────────────────────

export async function generateNetPositionExcel(
  companyId: number,
  companyName: string,
  startDate: string,
  endDate: string,
  dest?: NodeJS.WritableStream
): Promise<Buffer> {
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

  // Per-month breakdown detail
  for (const s of snapshots) {
    const inc = s.income;
    const netInc = round2(inc.totalRevenue - inc.totalExpenses);

    // Month heading
    const mHdr = wsInc.addRow([`${s.label}   (${s.periodFrom} → ${s.dateStr})`, "", "", ""]);
    mHdr.height = 22;
    mHdr.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.DARK_BLUE } };
      cell.font = { bold: true, color: { argb: C.WHITE }, size: 11 };
    });
    wsInc.mergeCells(`A${mHdr.number}:D${mHdr.number}`);

    // Revenue lines
    if (inc.revenueLines.length > 0) {
      const rHdr = wsInc.addRow(["  Revenue", "", "", ""]);
      rHdr.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16A34A" } };
        cell.font = { bold: true, color: { argb: C.WHITE }, size: 10 };
      });
      for (const l of inc.revenueLines) {
        const lr = wsInc.addRow([`    ${l.label}`, "", l.value, ""]);
        lr.getCell(3).numFmt = currencyFmt;
        lr.getCell(3).font = { color: { argb: C.GREEN } };
        lr.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.GREEN_BG } };
          setThin(cell);
        });
      }
      const rTot = wsInc.addRow(["  Total Revenue", "", inc.totalRevenue, ""]);
      rTot.getCell(1).font = { bold: true };
      rTot.getCell(3).numFmt = currencyFmt;
      rTot.getCell(3).font = { bold: true, color: { argb: C.GREEN } };
      rTot.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB3F5D3" } };
      });
    }

    // Expense lines
    const allExpLines = [...inc.directExpLines, ...inc.indirectExpLines, ...inc.generalExpLines];
    if (allExpLines.length > 0) {
      const eHdr = wsInc.addRow(["  Expenses", "", "", ""]);
      eHdr.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.RED } };
        cell.font = { bold: true, color: { argb: C.WHITE }, size: 10 };
      });
      for (const l of allExpLines) {
        const lr = wsInc.addRow([`    ${l.label}`, "", l.value, ""]);
        lr.getCell(3).numFmt = currencyFmt;
        lr.getCell(3).font = { color: { argb: C.RED } };
        lr.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.RED_BG } };
          setThin(cell);
        });
      }
      const eTot = wsInc.addRow(["  Total Expenses", "", inc.totalExpenses, ""]);
      eTot.getCell(1).font = { bold: true };
      eTot.getCell(3).numFmt = currencyFmt;
      eTot.getCell(3).font = { bold: true, color: { argb: C.RED } };
      eTot.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDCFCF" } };
      });
    }

    // Net income line
    const niRow = wsInc.addRow(["  Net Income", "", Math.abs(netInc), netInc >= 0 ? "Profit" : "Loss"]);
    niRow.height = 22;
    niRow.getCell(1).font = { bold: true, size: 11 };
    niRow.getCell(3).numFmt = currencyFmt;
    niRow.getCell(3).font = { bold: true, size: 11, color: { argb: netInc >= 0 ? C.GREEN : C.RED } };
    niRow.getCell(4).font = { bold: true, color: { argb: netInc >= 0 ? C.GREEN : C.RED } };
    niRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.YELLOW_BG } };
      cell.border = {
        top: { style: "thin", color: { argb: "FFAAAAAA" } },
        bottom: { style: "thin", color: { argb: "FFAAAAAA" } },
      };
    });

    wsInc.addRow([]);
  }

  [30, 10, 20, 12].forEach((w, i) => {
    wsInc.getColumn(i + 1).width = w;
  });

  // ═══════════════════════════════════════════════════════════════════
  //  SHEETS 3…N: one per month — simplified detail only
  // ═══════════════════════════════════════════════════════════════════
  for (let idx = 0; idx < snapshots.length; idx++) {
    const snap = snapshots[idx];
    const prevSnap = idx > 0 ? snapshots[idx - 1] : null;
    const prevMap = prevSnap ? valueMap([...prevSnap.forUsLines, ...prevSnap.onUsLines]) : new Map<string, number>();

    const ws = wb.addWorksheet(fmtSheetName(snap.dateStr));

    ws.mergeCells("A1:D1");
    styleTitle(ws.getCell("A1"), `${snap.label} — Net Position Details`, 14);
    ws.getRow(1).height = 34;

    ws.mergeCells("A2:D2");
    const meta = ws.getCell("A2");
    meta.value = `${companyName}   |   Snapshot: ${snap.dateStr}   |   Net Position: ${snap.netPosition >= 0 ? "+" : ""}${snap.netPosition.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    meta.font = { italic: true, size: 10, color: { argb: C.MUTED } };
    meta.alignment = { horizontal: "center" };
    ws.getRow(2).height = 18;

    ws.addRow([]);

    // KPI row
    const kHdr = ws.addRow(["Money Owed TO US", "Money WE OWE", "Net Position", "Status"]);
    kHdr.height = 22;
    kHdr.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: C.WHITE }, size: 10 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.MID_BLUE } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    const isPos = snap.netPosition >= 0;
    const kVal = ws.addRow([snap.forUsTotal, snap.onUsTotal, Math.abs(snap.netPosition), snap.netPositionLabel]);
    kVal.height = 28;
    kVal.getCell(1).numFmt = currencyFmt;
    kVal.getCell(1).font = { bold: true, size: 13, color: { argb: C.GREEN } };
    kVal.getCell(2).numFmt = currencyFmt;
    kVal.getCell(2).font = { bold: true, size: 13, color: { argb: C.RED } };
    kVal.getCell(3).numFmt = currencyFmt;
    kVal.getCell(3).font = { bold: true, size: 13, color: { argb: isPos ? C.GREEN : C.RED } };
    kVal.getCell(4).font = { bold: true, size: 12, color: { argb: isPos ? C.GREEN : C.RED } };
    kVal.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.LIGHT_BLUE } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = { bottom: { style: "medium", color: { argb: C.DARK_BLUE } } };
    });

    ws.addRow([]);

    // Column header for detail table — no Category column
    const prevLabel = prevSnap ? prevSnap.label : "Prior Month";
    const detHdr = ws.addRow(["Line Item", snap.label, prevLabel, "Change"]);
    detHdr.height = 22;
    detHdr.eachCell((cell) => styleHeader(cell));

    // WHAT WE HAVE
    const forUsSec = ws.addRow(["  MONEY OWED TO US", "", "", ""]);
    forUsSec.height = 22;
    forUsSec.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16A34A" } };
      cell.font = { bold: true, color: { argb: C.WHITE } };
    });

    let forUsSubtotal = 0;
    for (const line of snap.forUsLines) {
      const key = lineKey(line);
      const prevVal = prevMap.get(key) ?? 0;
      const change = prevSnap ? round2(line.value - prevVal) : null;
      forUsSubtotal += line.value;

      const dr = ws.addRow([line.label, line.value, prevSnap ? prevVal : null, change]);
      dr.getCell(1).font = { size: 10 };
      dr.getCell(2).numFmt = currencyFmt;
      dr.getCell(2).font = { color: { argb: C.GREEN } };
      if (prevSnap) {
        dr.getCell(3).numFmt = currencyFmt;
        dr.getCell(3).font = { color: { argb: C.MUTED } };
      } else {
        dr.getCell(3).value = "—";
        dr.getCell(3).font = { color: { argb: C.MUTED } };
      }
      if (change !== null) {
        dr.getCell(4).numFmt = signedFmt;
        dr.getCell(4).font = { italic: true, color: { argb: change >= 0 ? C.GREEN : C.RED } };
      } else {
        dr.getCell(4).value = "—";
        dr.getCell(4).font = { color: { argb: C.MUTED } };
      }
      dr.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.GREEN_BG } };
        setThin(cell);
      });
    }

    const forUsTotRow = ws.addRow([
      "Total — Money Owed TO US",
      forUsSubtotal,
      prevSnap ? prevSnap.forUsTotal : null,
      prevSnap ? round2(forUsSubtotal - prevSnap.forUsTotal) : null,
    ]);
    forUsTotRow.height = 20;
    forUsTotRow.getCell(1).font = { bold: true };
    forUsTotRow.getCell(2).numFmt = currencyFmt;
    forUsTotRow.getCell(2).font = { bold: true, color: { argb: C.GREEN } };
    if (prevSnap) {
      forUsTotRow.getCell(3).numFmt = currencyFmt;
      forUsTotRow.getCell(3).font = { bold: true, color: { argb: C.MUTED } };
      forUsTotRow.getCell(4).numFmt = signedFmt;
      forUsTotRow.getCell(4).font = {
        bold: true,
        color: { argb: forUsSubtotal - prevSnap.forUsTotal >= 0 ? C.GREEN : C.RED },
      };
    }
    forUsTotRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB3F5D3" } };
      cell.border = {
        top: { style: "thin", color: { argb: "FF16A34A" } },
        bottom: { style: "thin", color: { argb: "FF16A34A" } },
      };
    });

    ws.addRow([]);

    // WHAT WE OWE
    const onUsSec = ws.addRow(["  MONEY WE OWE", "", "", ""]);
    onUsSec.height = 22;
    onUsSec.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDC2626" } };
      cell.font = { bold: true, color: { argb: C.WHITE } };
    });

    let onUsSubtotal = 0;
    for (const line of snap.onUsLines) {
      const key = lineKey(line);
      const prevVal = prevMap.get(key) ?? 0;
      const change = prevSnap ? round2(line.value - prevVal) : null;
      onUsSubtotal += line.value;

      const dr = ws.addRow([line.label, line.value, prevSnap ? prevVal : null, change]);
      dr.getCell(1).font = { size: 10 };
      dr.getCell(2).numFmt = currencyFmt;
      dr.getCell(2).font = { color: { argb: C.RED } };
      if (prevSnap) {
        dr.getCell(3).numFmt = currencyFmt;
        dr.getCell(3).font = { color: { argb: C.MUTED } };
      } else {
        dr.getCell(3).value = "—";
        dr.getCell(3).font = { color: { argb: C.MUTED } };
      }
      if (change !== null) {
        dr.getCell(4).numFmt = signedFmt;
        dr.getCell(4).font = { italic: true, color: { argb: change <= 0 ? C.GREEN : C.RED } };
      } else {
        dr.getCell(4).value = "—";
        dr.getCell(4).font = { color: { argb: C.MUTED } };
      }
      dr.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.RED_BG } };
        setThin(cell);
      });
    }

    const onUsTotRow = ws.addRow([
      "Total — Money WE OWE",
      onUsSubtotal,
      prevSnap ? prevSnap.onUsTotal : null,
      prevSnap ? round2(onUsSubtotal - prevSnap.onUsTotal) : null,
    ]);
    onUsTotRow.height = 20;
    onUsTotRow.getCell(1).font = { bold: true };
    onUsTotRow.getCell(2).numFmt = currencyFmt;
    onUsTotRow.getCell(2).font = { bold: true, color: { argb: C.RED } };
    if (prevSnap) {
      onUsTotRow.getCell(3).numFmt = currencyFmt;
      onUsTotRow.getCell(3).font = { bold: true, color: { argb: C.MUTED } };
      const oweDiff = onUsSubtotal - prevSnap.onUsTotal;
      onUsTotRow.getCell(4).numFmt = signedFmt;
      onUsTotRow.getCell(4).font = { bold: true, color: { argb: oweDiff <= 0 ? C.GREEN : C.RED } };
    }
    onUsTotRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDCFCF" } };
      cell.border = {
        top: { style: "thin", color: { argb: C.RED } },
        bottom: { style: "thin", color: { argb: C.RED } },
      };
    });

    // NOT YET IN THE LEDGER — listed for information, never in the totals (wave 10)
    const memoLines = snap.notInLedger?.lines ?? [];
    if (memoLines.length > 0) {
      ws.addRow([]);
      const memoSec = ws.addRow(["  NOT YET IN THE LEDGER (not included in the net position)", "", "", ""]);
      memoSec.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: C.MUTED } };
      });
      for (const line of memoLines) {
        const mr = ws.addRow([line.label, line.value, "", ""]);
        mr.getCell(1).font = { italic: true, size: 10 };
        mr.getCell(2).numFmt = signedFmt;
      }
    }

    ws.getColumn(1).width = 40;
    ws.getColumn(2).width = 20;
    ws.getColumn(3).width = 20;
    ws.getColumn(4).width = 18;
  }

  const rawBuf = await wb.xlsx.writeBuffer();
  const buf = Buffer.isBuffer(rawBuf) ? rawBuf : Buffer.from(rawBuf);
  if (dest) {
    dest.write(buf);
  }
  return buf;
}
