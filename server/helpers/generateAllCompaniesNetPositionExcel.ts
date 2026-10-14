/**
 * Generates a single Excel workbook covering ALL companies.
 * Structure:
 *   Sheet 1 "Net Position"  — month rows × company columns (balance-sheet snapshot)
 *   Sheet 2 "Income"        — month rows × company columns (revenue + net profit)
 *
 * Used by the daily WhatsApp scheduler.
 */

import ExcelJS from "exceljs";
import { generateMonthEnds, fmtMonthLabel } from "./generateNetPositionExcel";
import { calculateNetPositionAsOf } from "./calculateNetPositionAsOf";
import { calculateIncomeStatementForPeriod } from "./calculateIncomeStatementForPeriod";
import { round2 } from "../netPositionHelper";

function addOneDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

const C = {
  DARK_BLUE: "FF1E3A5F",
  MID_BLUE: "FF2D5F8A",
  GREEN: "FF16A34A",
  RED: "FFDC2626",
  GREEN_BG: "FFD1FAE5",
  RED_BG: "FFFEE2E2",
  GRAY_BG: "FFF3F4F6",
  WHITE: "FFFFFFFF",
  MUTED: "FF6B7280",
};

const currencyFmt = "#,##0.00";

function hdr(cell: ExcelJS.Cell, bgArgb = C.DARK_BLUE) {
  cell.font = { bold: true, color: { argb: C.WHITE }, size: 10 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = { bottom: { style: "thin", color: { argb: "FFAAAAAA" } } };
}

function subHdr(cell: ExcelJS.Cell) {
  cell.font = { bold: true, color: { argb: C.WHITE }, size: 10 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.MID_BLUE } };
  cell.alignment = { horizontal: "center", vertical: "middle" };
}

function numCell(cell: ExcelJS.Cell, value: number, _positive = true) {
  cell.value = value;
  cell.numFmt = currencyFmt;
  cell.alignment = { horizontal: "right" };
  const isPos = value >= 0;
  const bgArgb = isPos ? C.GREEN_BG : C.RED_BG;
  const fgArgb = isPos ? C.GREEN : C.RED;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
  cell.font = { color: { argb: fgArgb }, size: 10 };
}

function plainNum(cell: ExcelJS.Cell, value: number) {
  cell.value = value;
  cell.numFmt = currencyFmt;
  cell.alignment = { horizontal: "right" };
  cell.font = { size: 10 };
}

export async function generateAllCompaniesNetPositionExcel(
  companies: { id: number; name: string }[],
  startDate: string,
  endDate: string
): Promise<Buffer> {
  const monthEnds = generateMonthEnds(startDate, endDate);
  if (monthEnds.length === 0) throw new Error("No months in range");

  type MonthData = {
    label: string;
    dateStr: string;
    netPosition: number;
    forUs: number;
    onUs: number;
    revenue: number;
    netProfit: number;
  };

  const companyMonths: { company: { id: number; name: string }; months: MonthData[] }[] = [];

  for (const company of companies) {
    const months: MonthData[] = [];
    let prevDate: string | null = null;

    for (const dateStr of monthEnds) {
      const periodFrom = prevDate ? addOneDay(prevDate) : startDate;
      const [snap, income] = await Promise.all([
        calculateNetPositionAsOf(company.id, dateStr),
        calculateIncomeStatementForPeriod(company.id, periodFrom, dateStr),
      ]);
      months.push({
        label: fmtMonthLabel(dateStr),
        dateStr,
        netPosition: snap.netPosition,
        forUs: snap.forUsTotal,
        onUs: snap.onUsTotal,
        revenue: round2(income.totalRevenue),
        netProfit: round2(income.totalRevenue - income.totalExpenses),
      });
      prevDate = dateStr;
    }
    companyMonths.push({ company, months });
  }

  const ExcelJS = await import("exceljs");
  const wb = new ExcelJS.default.Workbook();
  wb.creator = "ERP System";
  wb.created = new Date();

  // ════════════════════════════════════════════════════════════
  //  SHEET 1: Net Position (balance-sheet snapshot)
  // ════════════════════════════════════════════════════════════
  const ws1 = wb.addWorksheet("Net Position");

  const totalCols1 = 1 + companies.length * 3; // Month + (ForUs, OnUs, Net) per company
  ws1.mergeCells(1, 1, 1, totalCols1);
  const t1 = ws1.getCell(1, 1);
  t1.value = `All Companies — Net Position Snapshot  |  ${startDate}  →  ${endDate}`;
  t1.font = { bold: true, size: 14, color: { argb: C.WHITE } };
  t1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.DARK_BLUE } };
  t1.alignment = { horizontal: "center", vertical: "middle" };
  ws1.getRow(1).height = 32;

  // Row 2: company group headers
  ws1.getRow(2).height = 20;
  ws1.getCell(2, 1).value = "";
  for (let ci = 0; ci < companies.length; ci++) {
    const colStart = 2 + ci * 3;
    ws1.mergeCells(2, colStart, 2, colStart + 2);
    const cell = ws1.getCell(2, colStart);
    cell.value = companies[ci].name;
    subHdr(cell);
  }

  // Row 3: column headers
  ws1.getRow(3).height = 22;
  const hCell1 = ws1.getCell(3, 1);
  hCell1.value = "Month";
  hdr(hCell1);
  ws1.getColumn(1).width = 14;
  for (let ci = 0; ci < companies.length; ci++) {
    const colStart = 2 + ci * 3;
    const labels = ["They Owe Us", "We Owe Them", "Net Position"];
    for (let j = 0; j < 3; j++) {
      const cell = ws1.getCell(3, colStart + j);
      cell.value = labels[j];
      hdr(cell, C.MID_BLUE);
      ws1.getColumn(colStart + j).width = 16;
    }
  }

  // Data rows
  for (let mi = 0; mi < monthEnds.length; mi++) {
    const rowNum = 4 + mi;
    const row = ws1.getRow(rowNum);
    row.height = 18;
    const mLabel = ws1.getCell(rowNum, 1);
    mLabel.value = companyMonths[0]?.months[mi]?.label ?? "";
    mLabel.font = { bold: true, size: 10 };
    mLabel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.GRAY_BG } };

    for (let ci = 0; ci < companyMonths.length; ci++) {
      const md = companyMonths[ci].months[mi];
      const colStart = 2 + ci * 3;
      plainNum(ws1.getCell(rowNum, colStart), md.forUs);
      plainNum(ws1.getCell(rowNum, colStart + 1), md.onUs);
      numCell(ws1.getCell(rowNum, colStart + 2), md.netPosition);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  SHEET 2: Income (revenue + net profit)
  // ════════════════════════════════════════════════════════════
  const ws2 = wb.addWorksheet("Income");

  const totalCols2 = 1 + companies.length * 2; // Month + (Revenue, Net Profit) per company
  ws2.mergeCells(1, 1, 1, totalCols2);
  const t2 = ws2.getCell(1, 1);
  t2.value = `All Companies — Revenue & Net Profit  |  ${startDate}  →  ${endDate}`;
  t2.font = { bold: true, size: 14, color: { argb: C.WHITE } };
  t2.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.DARK_BLUE } };
  t2.alignment = { horizontal: "center", vertical: "middle" };
  ws2.getRow(1).height = 32;

  // Row 2: company group headers
  ws2.getRow(2).height = 20;
  ws2.getCell(2, 1).value = "";
  for (let ci = 0; ci < companies.length; ci++) {
    const colStart = 2 + ci * 2;
    ws2.mergeCells(2, colStart, 2, colStart + 1);
    const cell = ws2.getCell(2, colStart);
    cell.value = companies[ci].name;
    subHdr(cell);
  }

  // Row 3: column headers
  ws2.getRow(3).height = 22;
  const hCell2 = ws2.getCell(3, 1);
  hCell2.value = "Month";
  hdr(hCell2);
  ws2.getColumn(1).width = 14;
  for (let ci = 0; ci < companies.length; ci++) {
    const colStart = 2 + ci * 2;
    ["Revenue", "Net Profit"].forEach((lbl, j) => {
      const cell = ws2.getCell(3, colStart + j);
      cell.value = lbl;
      hdr(cell, C.MID_BLUE);
      ws2.getColumn(colStart + j).width = 16;
    });
  }

  // Data rows
  for (let mi = 0; mi < monthEnds.length; mi++) {
    const rowNum = 4 + mi;
    const row = ws2.getRow(rowNum);
    row.height = 18;
    const mLabel = ws2.getCell(rowNum, 1);
    mLabel.value = companyMonths[0]?.months[mi]?.label ?? "";
    mLabel.font = { bold: true, size: 10 };
    mLabel.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.GRAY_BG } };

    for (let ci = 0; ci < companyMonths.length; ci++) {
      const md = companyMonths[ci].months[mi];
      const colStart = 2 + ci * 2;
      plainNum(ws2.getCell(rowNum, colStart), md.revenue);
      numCell(ws2.getCell(rowNum, colStart + 1), md.netProfit);
    }
  }

  // ════════════════════════════════════════════════════════════
  //  Per-company detail sheets (summary view)
  // ════════════════════════════════════════════════════════════
  for (const { company, months } of companyMonths) {
    const safeName = company.name.replace(/[^a-zA-Z0-9 ]/g, "").substring(0, 25);
    const wsC = wb.addWorksheet(safeName);

    wsC.mergeCells("A1:F1");
    const tc = wsC.getCell("A1");
    tc.value = `${company.name} — Net Position`;
    tc.font = { bold: true, size: 13, color: { argb: C.WHITE } };
    tc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.DARK_BLUE } };
    tc.alignment = { horizontal: "center", vertical: "middle" };
    wsC.getRow(1).height = 28;

    const headers = ["Month", "They Owe Us", "We Owe Them", "Net Position", "Revenue", "Net Profit"];
    const widths = [14, 16, 16, 16, 16, 16];
    const hRow = wsC.addRow(headers);
    hRow.height = 20;
    hRow.eachCell((cell, colNum) => {
      hdr(cell, C.MID_BLUE);
      wsC.getColumn(colNum).width = widths[colNum - 1];
    });

    for (const m of months) {
      const dr = wsC.addRow([]);
      dr.height = 18;
      const mc = wsC.getCell(dr.number, 1);
      mc.value = m.label;
      mc.font = { bold: true, size: 10 };
      mc.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.GRAY_BG } };
      plainNum(wsC.getCell(dr.number, 2), m.forUs);
      plainNum(wsC.getCell(dr.number, 3), m.onUs);
      numCell(wsC.getCell(dr.number, 4), m.netPosition);
      plainNum(wsC.getCell(dr.number, 5), m.revenue);
      numCell(wsC.getCell(dr.number, 6), m.netProfit);
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
