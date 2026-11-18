// Extracted from ./netProfitExcelSheets.ts to keep that module under the source-size cap.
import ExcelJS from "exceljs";
import { toMoney } from "../lib/money";
import { computeStats, fmt, type NetProfitSheetContext } from "./netProfitExcelSheetsComputeStats";

export function writeSheet(
  ctx: NetProfitSheetContext,
  ws: ExcelJS.Worksheet,
  stats: ReturnType<typeof computeStats>,
  sheetLabel: string,
  _showNetPosition: boolean,
  _npValue: number
) {
  const {
    salesTotal,
    directIncDetails,
    totalIncome,
    indirectIncTotal,
    indirectIncDetails,
    purchaseTotal,
    purchaseDetails,
    directExpTotal,
    directExpDetails,
    indirectExpTotal,
    indirectExpDetails,
    openingSt,
    closingSt,
    totalCOGS,
    grossProfit,
    netProfit,
    grossMarginPct,
    netMarginPct,
    monthlyMode,
  } = stats;

  ws.properties.defaultColWidth = 20;

  // Title
  ws.mergeCells("A1:E1");
  const titleCell = ws.getCell("A1");
  titleCell.value = `Profit & Loss — ${ctx.companyName}`;
  titleCell.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 36;

  ws.mergeCells("A2:E2");
  const subCell = ws.getCell("A2");
  subCell.value = `Period: ${sheetLabel}${monthlyMode ? "  |  COGS = Purchases + Direct + Indirect Expenses (no stock adjustment for individual months)" : ""}`;
  subCell.font = { italic: true, size: 11, color: { argb: "FF555555" } };
  subCell.alignment = { horizontal: "center" };
  ws.getRow(2).height = 22;
  ws.addRow([]);

  // KPI Summary block
  const kpiHdr = ws.addRow(["", "SUMMARY", "", "", ""]);
  kpiHdr.getCell(2).font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
  kpiHdr.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
  ws.mergeCells(`B${kpiHdr.number}:E${kpiHdr.number}`);

  const kpiRows: [string, string | number, boolean][] = [
    ["Total Income (Sales + Direct Inc)", fmt(totalIncome), false],
    ["Total COGS", fmt(totalCOGS), false],
    ["Gross Profit", fmt(grossProfit), true],
    ["Net Profit", fmt(netProfit), true],
    ["Gross Margin %", grossMarginPct.toFixed(1) + "%", false],
    ["Net Margin %", netMarginPct.toFixed(1) + "%", false],
  ];

  for (const [label, value, isBold] of kpiRows) {
    const row = ws.addRow(["", label, "", "", value]);
    const numVal = typeof value === "number" ? value : toMoney(String(value).replace(/[^0-9.-]/g, "")).toNumber();
    const profColor = numVal >= 0 ? "FF16A34A" : "FFDC2626";
    row.getCell(2).font = { bold: isBold };
    row.getCell(5).font = { bold: isBold, color: { argb: isBold ? profColor : "FF374151" } };
    if (typeof value === "number" || !String(value).includes("%")) row.getCell(5).numFmt = "$#,##0.##";
    ws.mergeCells(`B${row.number}:D${row.number}`);
    if (isBold) {
      row.eachCell((cell: ExcelJS.Cell) => {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: numVal >= 0 ? "FFD1FAE5" : "FFFEE2E2" },
        };
      });
      row.getCell(2).font = { bold: true };
      row.getCell(5).font = { bold: true, color: { argb: profColor } };
    }
  }
  ws.addRow([]);

  // Helper: section header row
  const secHeader = (title: string, color: string) => {
    const hRow = ws.addRow([title, "Account", "Debit", "Credit", "Net"]);
    hRow.eachCell((cell: ExcelJS.Cell, col: number) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
      cell.alignment = { horizontal: col <= 2 ? "left" : "right" };
    });
  };

  // Helper: account detail rows
  const addAccRows = (rows: { name: string; debit: number; credit: number; balance: number }[]) => {
    if (rows.length === 0) {
      const empty = ws.addRow(["", "(none)", "", "", ""]);
      empty.getCell(2).font = { italic: true, color: { argb: "FF888888" } };
      return;
    }
    for (const r of rows) {
      const dr = ws.addRow(["", r.name, fmt(r.debit), fmt(r.credit), fmt(r.balance)]);
      dr.getCell(3).numFmt = "$#,##0";
      dr.getCell(4).numFmt = "$#,##0";
      dr.getCell(5).numFmt = "$#,##0";
      dr.getCell(5).font = { color: { argb: r.balance >= 0 ? "FF16A34A" : "FFDC2626" } };
    }
  };

  // Helper: subtotal row
  const subTot = (label: string, value: number) => {
    const r = ws.addRow(["", label, "", "", fmt(value)]);
    r.eachCell((cell: ExcelJS.Cell) => {
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } };
    });
    r.getCell(5).numFmt = "$#,##0";
    r.getCell(5).font = { bold: true, color: { argb: value >= 0 ? "FF16A34A" : "FFDC2626" } };
    ws.addRow([]);
  };

  // === INCOME SECTION ===
  secHeader("INCOME", "FF1E3A5F");
  // Sales row
  const salesRow = ws.addRow(["", "Total Sales (POS & Revenue)", "", "", fmt(salesTotal)]);
  salesRow.getCell(5).numFmt = "$#,##0";
  salesRow.getCell(5).font = { color: { argb: "FF16A34A" } };
  // Direct Incomes
  if (directIncDetails.length > 0) {
    const diHdr = ws.addRow(["", "— Direct Incomes", "", "", ""]);
    diHdr.getCell(2).font = { italic: true, color: { argb: "FF555555" } };
    addAccRows(directIncDetails);
  }
  subTot("Total Income", totalIncome);

  // === COST OF GOODS SOLD ===
  secHeader("COST OF GOODS SOLD (COGS)", "FFDC2626");
  if (!monthlyMode && openingSt > 0) {
    const osRow = ws.addRow(["", "Opening Stock", "", "", fmt(openingSt)]);
    osRow.getCell(5).numFmt = "$#,##0";
    osRow.getCell(5).font = { color: { argb: "FFDC2626" } };
  }

  // Purchases sub-section
  const pHdr = ws.addRow(["", "— Purchases", "", "", ""]);
  pHdr.getCell(2).font = { italic: true, bold: true, color: { argb: "FFDC2626" } };
  addAccRows(purchaseDetails);
  const pTotRow = ws.addRow(["", "Total Purchases", "", "", fmt(purchaseTotal)]);
  pTotRow.getCell(2).font = { bold: true };
  pTotRow.getCell(5).numFmt = "$#,##0";
  pTotRow.getCell(5).font = { bold: true, color: { argb: "FFDC2626" } };

  // Direct Expenses sub-section
  const deHdr = ws.addRow(["", "— Direct Expenses", "", "", ""]);
  deHdr.getCell(2).font = { italic: true, bold: true, color: { argb: "FFB45309" } };
  addAccRows(directExpDetails);
  const deTotRow = ws.addRow(["", "Total Direct Expenses", "", "", fmt(directExpTotal)]);
  deTotRow.getCell(2).font = { bold: true };
  deTotRow.getCell(5).numFmt = "$#,##0";
  deTotRow.getCell(5).font = { bold: true, color: { argb: "FFDC2626" } };

  // Indirect Expenses sub-section
  const ieHdr = ws.addRow(["", "— Indirect Expenses", "", "", ""]);
  ieHdr.getCell(2).font = { italic: true, bold: true, color: { argb: "FF7C3AED" } };
  addAccRows(indirectExpDetails);
  const ieTotRow = ws.addRow(["", "Total Indirect Expenses", "", "", fmt(indirectExpTotal)]);
  ieTotRow.getCell(2).font = { bold: true };
  ieTotRow.getCell(5).numFmt = "$#,##0";
  ieTotRow.getCell(5).font = { bold: true, color: { argb: "FFDC2626" } };

  if (!monthlyMode && closingSt > 0) {
    const csRow = ws.addRow(["", "Less: Closing Stock", "", "", fmt(-closingSt)]);
    csRow.getCell(5).numFmt = "$#,##0";
    csRow.getCell(5).font = { color: { argb: "FF16A34A" } };
  }

  // COGS total
  const cogsRow = ws.addRow(["TOTAL COGS", "", "", "", fmt(totalCOGS)]);
  cogsRow.eachCell((cell: ExcelJS.Cell) => {
    cell.font = { bold: true, size: 12, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDC2626" } };
    cell.alignment = { horizontal: "center" };
  });
  cogsRow.getCell(5).numFmt = "$#,##0.##";
  ws.mergeCells(`A${cogsRow.number}:D${cogsRow.number}`);
  ws.getRow(cogsRow.number).height = 24;
  ws.addRow([]);

  // GROSS PROFIT
  const gpRow = ws.addRow(["GROSS PROFIT", "", "", "", fmt(grossProfit)]);
  gpRow.eachCell((cell: ExcelJS.Cell) => {
    cell.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: grossProfit >= 0 ? "FF059669" : "FFDC2626" },
    };
    cell.alignment = { horizontal: "center" };
  });
  gpRow.getCell(5).numFmt = "$#,##0.##";
  ws.mergeCells(`A${gpRow.number}:D${gpRow.number}`);
  ws.getRow(gpRow.number).height = 28;

  // INDIRECT INCOME (wave 13): earned below gross profit. Shown only when the
  // period has some, so a workbook without indirect income keeps its layout.
  if (indirectIncDetails.length > 0) {
    secHeader("INDIRECT INCOME", "FF0F766E");
    addAccRows(indirectIncDetails);
    subTot("Total Indirect Income", indirectIncTotal);
  }

  // NET PROFIT (= Gross Profit + Indirect Income; every expense is in COGS)
  const npRow = ws.addRow(["NET PROFIT", "", "", "", fmt(netProfit)]);
  npRow.eachCell((cell: ExcelJS.Cell) => {
    cell.font = { bold: true, size: 13, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: netProfit >= 0 ? "FF2563EB" : "FFDC2626" },
    };
    cell.alignment = { horizontal: "center" };
  });
  npRow.getCell(5).numFmt = "$#,##0.##";
  ws.mergeCells(`A${npRow.number}:D${npRow.number}`);
  ws.getRow(npRow.number).height = 28;
  ws.addRow([]);

  // RATIOS
  const ratioHdr = ws.addRow(["RATIOS", "", "", "", ""]);
  ratioHdr.getCell(1).font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
  ratioHdr.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4B5563" } };

  const gmRow = ws.addRow(["", "Gross Margin %", "", "", grossMarginPct.toFixed(2) + "%"]);
  gmRow.getCell(2).font = { bold: false };
  gmRow.getCell(5).font = { bold: true };
  ws.mergeCells(`B${gmRow.number}:D${gmRow.number}`);

  const nmRow = ws.addRow(["", "Net Margin %", "", "", netMarginPct.toFixed(2) + "%"]);
  nmRow.getCell(2).font = { bold: false };
  nmRow.getCell(5).font = { bold: true };
  ws.mergeCells(`B${nmRow.number}:D${nmRow.number}`);

  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 38;
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 16;
  ws.getColumn(5).width = 16;
}
