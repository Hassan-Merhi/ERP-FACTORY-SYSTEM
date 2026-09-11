import ExcelJS from "exceljs";
/**
 * Statistics and ExcelJS sheet rendering for the net-profit workbook.
 *
 * These were declared inside the /api/reports/net-profit-excel handler but take
 * everything they need as arguments - the stats object, the worksheet, the
 * labels - so they are a function of their inputs alone.
 *
 * config/report-characterization.json pins the workbook's cell values across the
 * move, which is what makes an extraction of this size checkable at all.
 */

/**
 * The three pieces of per-request context these functions need. They were
 * captured from the handler's scope; passing them explicitly is the only change
 * to the code that moved.
 */
export interface NetProfitSheetContext {
  companyAccounts: any[];
  importChargesIds: Set<number>;
  companyName: string;
}

export const fmt = (n: number) => parseFloat(n.toFixed(2));

export function computeBalancesFromEntries(entries: any[]): Map<number, { debit: number; credit: number }> {
  const bal = new Map<number, { debit: number; credit: number }>();
  for (const e of entries) {
    if (e.ledgerAccountId) {
      const d = parseFloat(e.debitAmount || "0"),
        c = parseFloat(e.creditAmount || "0");
      const cur = bal.get(e.ledgerAccountId) || { debit: 0, credit: 0 };
      bal.set(e.ledgerAccountId, { debit: cur.debit + d, credit: cur.credit + c });
    }
  }
  return bal;
}

export function computeStats(
  ctx: NetProfitSheetContext,
  balances: Map<number, { debit: number; credit: number }>,
  salesTotal: number,
  openingSt: number,
  closingSt: number,
  monthlyMode = false
) {
  // Direct Incomes (non-sales income accounts)
  const directIncAccounts = ctx.companyAccounts.filter(
    (acc) =>
      acc.accountType === "Income" &&
      acc.subType === "Direct Income" &&
      !acc.code?.includes("SALES") &&
      !acc.name?.toLowerCase().includes("sales")
  );
  let directIncTotal = 0;
  const directIncDetails = directIncAccounts
    .map((acc) => {
      const b = balances.get(acc.id) || { debit: 0, credit: 0 };
      const net = b.credit - b.debit;
      directIncTotal += net;
      return { id: acc.id, name: acc.name, debit: b.debit, credit: b.credit, balance: net };
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0);

  const totalIncome = salesTotal + directIncTotal;

  // Purchases
  const purchaseAccounts = ctx.companyAccounts.filter(
    (acc) => acc.code === "PURCHASES" || acc.code?.startsWith("PURCHASES-")
  );
  let purchaseTotal = 0;
  const purchaseDetails = purchaseAccounts
    .map((acc) => {
      const b = balances.get(acc.id) || { debit: 0, credit: 0 };
      const net = b.debit - b.credit;
      purchaseTotal += net;
      return { id: acc.id, name: acc.name, debit: b.debit, credit: b.credit, balance: net };
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0);

  // Direct Expenses
  const directExpAccounts = ctx.companyAccounts.filter(
    (acc) =>
      acc.code !== "PURCHASES" &&
      !acc.code?.startsWith("PURCHASES") &&
      (acc.accountType === "Direct Expense" ||
        (acc.accountType === "Expense" && acc.subType === "Direct Expense") ||
        ctx.importChargesIds.has(acc.id))
  );
  let directExpTotal = 0;
  const directExpDetails = directExpAccounts
    .map((acc) => {
      const b = balances.get(acc.id) || { debit: 0, credit: 0 };
      const net = b.debit - b.credit;
      directExpTotal += net;
      return { id: acc.id, name: acc.name, debit: b.debit, credit: b.credit, balance: net };
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0);

  // Indirect Expenses
  const indirectExpAccounts = ctx.companyAccounts.filter(
    (acc) =>
      acc.accountType === "Indirect Expense" &&
      acc.code !== "PRODUCTION_ADJUSTMENT" &&
      acc.code !== "CONSUMPTION_EXPENSE" &&
      acc.code !== "PURCHASES" &&
      !acc.code?.startsWith("PURCHASES")
  );
  let indirectExpTotal = 0;
  const indirectExpDetails = indirectExpAccounts
    .map((acc) => {
      const b = balances.get(acc.id) || { debit: 0, credit: 0 };
      const net = b.debit - b.credit;
      indirectExpTotal += net;
      return { id: acc.id, name: acc.name, debit: b.debit, credit: b.credit, balance: net };
    })
    .filter((r) => r.debit !== 0 || r.credit !== 0);

  // COGS: Opening + Purchases + Direct + Indirect - Closing (monthlyMode: no opening/closing)
  const totalCOGS = monthlyMode
    ? purchaseTotal + directExpTotal + indirectExpTotal
    : openingSt + purchaseTotal + directExpTotal + indirectExpTotal - closingSt;

  const grossProfit = totalIncome - totalCOGS;
  const netProfit = grossProfit;
  const grossMarginPct = totalIncome > 0 ? (grossProfit / totalIncome) * 100 : 0;
  const netMarginPct = totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0;

  return {
    salesTotal,
    directIncTotal,
    directIncDetails,
    totalIncome,
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
  };
}

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
    directIncTotal: _directIncTotal,
    directIncDetails,
    totalIncome,
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
    const numVal = typeof value === "number" ? value : parseFloat(String(value).replace(/[^0-9.-]/g, ""));
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
  const addAccRows = (rows: any[]) => {
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

  // NET PROFIT (= Gross Profit since all expenses are in COGS)
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
  const _pctFmt = "0.00%";

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
