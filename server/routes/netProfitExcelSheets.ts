import ExcelJS from "exceljs";
import { computeStats, fmt, type NetProfitSheetContext } from "./netProfitExcelSheetsComputeStats";
export { computeBalancesFromEntries, computeStats, fmt, netProfitSection } from "./netProfitExcelSheetsComputeStats";
export type {
  NetProfitBalanceEntry,
  NetProfitSection,
  NetProfitSheetContext,
} from "./netProfitExcelSheetsComputeStats";
export { writeSheet } from "./netProfitExcelSheetsWriteSheet";

export function writeSummarySheet(
  ctx: NetProfitSheetContext,
  ws: ExcelJS.Worksheet,
  monthStatsList: ReturnType<typeof computeStats>[],
  totalStats: ReturnType<typeof computeStats>,
  monthLabels: string[],
  _npValue: number
) {
  const numMonths = monthLabels.length;
  const totalCol = numMonths + 2; // col B = month1, ..., last month col = B+numMonths-1, total = B+numMonths

  ws.properties.defaultColWidth = 16;

  // Title
  ws.mergeCells(1, 1, 1, totalCol);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `P&L Summary — ${ctx.companyName}`;
  titleCell.font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 36;

  // Header row: [blank] | Month1 | Month2 | ... | TOTAL
  const hdrRowData = [""];
  for (const ml of monthLabels) hdrRowData.push(ml);
  hdrRowData.push("TOTAL");
  const hdrRow = ws.addRow(hdrRowData);
  hdrRow.eachCell((cell: ExcelJS.Cell, col: number) => {
    if (col === 1) return;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: col === totalCol ? "FF1E3A5F" : "FF374151" },
    };
    cell.alignment = { horizontal: "right" };
  });
  ws.getRow(2).height = 22;

  // Helper: write a data row
  const numFmt = "$#,##0";

  const writeRow = (
    label: string,
    monthVals: number[],
    totalVal: number,
    opts: {
      bold?: boolean;
      highlight?: boolean;
      colorize?: boolean;
      pct?: boolean;
      labelColor?: string;
      indent?: boolean;
    } = {}
  ) => {
    const rowData: (string | number)[] = [opts.indent ? "  " + label : label];
    for (const v of monthVals) rowData.push(opts.pct ? v / 100 : fmt(v));
    rowData.push(opts.pct ? fmt(totalVal) / 100 : fmt(totalVal));
    const row = ws.addRow(rowData);
    if (opts.bold) row.getCell(1).font = { bold: true };
    if (opts.labelColor) row.getCell(1).font = { bold: opts.bold, color: { argb: opts.labelColor } };

    for (let c = 2; c <= totalCol; c++) {
      const cell = row.getCell(c);
      const val = c === totalCol ? totalVal : monthVals[c - 2];
      cell.numFmt = opts.pct ? "0.00%" : numFmt;
      if (opts.bold) cell.font = { bold: true };
      if (opts.colorize) cell.font = { bold: opts.bold, color: { argb: val >= 0 ? "FF16A34A" : "FFDC2626" } };
      if (opts.highlight)
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: val >= 0 ? "FFD1FAE5" : "FFFEE2E2" } };
    }
    return row;
  };

  const writeSectionHdr = (label: string, color: string) => {
    const rowData = [label];
    for (let i = 0; i <= numMonths; i++) rowData.push("");
    const row = ws.addRow(rowData);
    row.eachCell((cell: ExcelJS.Cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
    });
    ws.mergeCells(row.number, 1, row.number, totalCol);
    ws.getRow(row.number).height = 20;
  };

  const blankRow = () => ws.addRow(Array(totalCol).fill(""));

  // === INCOME ===
  writeSectionHdr("INCOME", "FF1E3A5F");
  writeRow(
    "Sales Revenue",
    monthStatsList.map((s) => s.salesTotal),
    totalStats.salesTotal,
    { colorize: true }
  );
  writeRow(
    "Direct Incomes",
    monthStatsList.map((s) => s.directIncTotal),
    totalStats.directIncTotal,
    { colorize: true }
  );
  writeRow(
    "TOTAL INCOME",
    monthStatsList.map((s) => s.totalIncome),
    totalStats.totalIncome,
    { bold: true, colorize: true, highlight: true }
  );
  blankRow();

  // === COGS ===
  writeSectionHdr("COST OF GOODS SOLD (COGS)", "FFDC2626");
  // Opening Stock: only show in total column (not per-month)
  {
    const rowData: (string | number)[] = ["Opening Stock"];
    for (let i = 0; i < numMonths; i++) rowData.push("—");
    rowData.push(fmt(totalStats.openingSt));
    const row = ws.addRow(rowData);
    row.getCell(1).font = { italic: true };
    row.getCell(totalCol).numFmt = numFmt;
    row.getCell(totalCol).font = { color: { argb: "FFDC2626" } };
  }
  writeRow(
    "Purchases",
    monthStatsList.map((s) => s.purchaseTotal),
    totalStats.purchaseTotal,
    { colorize: true, indent: true }
  );
  writeRow(
    "Direct Expenses",
    monthStatsList.map((s) => s.directExpTotal),
    totalStats.directExpTotal,
    { colorize: true, indent: true }
  );
  writeRow(
    "Indirect Expenses",
    monthStatsList.map((s) => s.indirectExpTotal),
    totalStats.indirectExpTotal,
    { colorize: true, indent: true }
  );
  // Closing Stock: only show in total column (negative, reduces COGS)
  {
    const rowData: (string | number)[] = ["Less: Closing Stock"];
    for (let i = 0; i < numMonths; i++) rowData.push("—");
    rowData.push(fmt(-totalStats.closingSt));
    const row = ws.addRow(rowData);
    row.getCell(1).font = { italic: true };
    row.getCell(totalCol).numFmt = numFmt;
    row.getCell(totalCol).font = { color: { argb: "FF16A34A" } };
  }
  writeRow(
    "TOTAL COGS",
    monthStatsList.map((s) => s.totalCOGS),
    totalStats.totalCOGS,
    { bold: true, colorize: true, highlight: true }
  );
  blankRow();

  // === GROSS PROFIT ===
  writeSectionHdr("GROSS PROFIT", "FF059669");
  writeRow(
    "Gross Profit",
    monthStatsList.map((s) => s.grossProfit),
    totalStats.grossProfit,
    { bold: true, colorize: true, highlight: true }
  );
  blankRow();

  // === NET PROFIT ===
  writeSectionHdr("NET PROFIT", "FF2563EB");
  // Indirect income (wave 13), only when some month has it, so the layout of
  // a workbook without indirect income is unchanged.
  if (totalStats.indirectIncDetails.length > 0 || monthStatsList.some((s) => s.indirectIncDetails.length > 0)) {
    writeRow(
      "Indirect Incomes",
      monthStatsList.map((s) => s.indirectIncTotal),
      totalStats.indirectIncTotal,
      { colorize: true, indent: true }
    );
  }
  writeRow(
    "Net Profit",
    monthStatsList.map((s) => s.netProfit),
    totalStats.netProfit,
    { bold: true, colorize: true, highlight: true }
  );
  blankRow();

  // === RATIOS ===
  writeSectionHdr("RATIOS", "FF4B5563");
  writeRow(
    "Gross Margin %",
    monthStatsList.map((s) => s.grossMarginPct),
    totalStats.grossMarginPct,
    { pct: true }
  );
  writeRow(
    "Net Margin %",
    monthStatsList.map((s) => s.netMarginPct),
    totalStats.netMarginPct,
    { pct: true }
  );
  blankRow();

  // Column widths
  ws.getColumn(1).width = 36;
  for (let c = 2; c <= totalCol; c++) ws.getColumn(c).width = 14;
}

export function fmtMonthLabel(mk: string) {
  const [yr, mo] = mk.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[parseInt(mo) - 1]} ${yr}`;
}
