import ExcelJS from "exceljs";
import type { GroupNetPositionSnapshot, GroupNetPositionCompany } from "./groupNetPosition";

const COLORS = {
  navy: "FF1F3864",
  blue: "FF2D5F8A",
  green: "FF166534",
  red: "FF991B1B",
  lightGreen: "FFDCFCE7",
  lightRed: "FFFEE2E2",
  gray: "FFF3F4F6",
  white: "FFFFFFFF",
};

const amountFormat = "#,##0.00;[Red]-#,##0.00";

function styleHeader(cell: ExcelJS.Cell, fill = COLORS.navy) {
  cell.font = { bold: true, color: { argb: COLORS.white } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
}

function styleAmount(cell: ExcelJS.Cell, value: number, emphasize = false) {
  cell.value = value;
  cell.numFmt = amountFormat;
  cell.alignment = { horizontal: "right" };
  if (emphasize) {
    const positive = value >= 0;
    cell.font = { bold: true, color: { argb: positive ? COLORS.green : COLORS.red } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: positive ? COLORS.lightGreen : COLORS.lightRed },
    };
  }
}

function safeSheetName(raw: string, used: Set<string>): string {
  const base =
    raw
      .replace(/[\\/?*[\]:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 28) || "Company";
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tag = ` ${suffix++}`;
    candidate = `${base.slice(0, Math.max(1, 31 - tag.length))}${tag}`;
  }
  used.add(candidate);
  return candidate;
}

function addCompanyDetailSheet(workbook: ExcelJS.Workbook, company: GroupNetPositionCompany, used: Set<string>) {
  const ws = workbook.addWorksheet(safeSheetName(company.companyName, used));
  ws.columns = [
    { key: "category", width: 24 },
    { key: "account", width: 44 },
    { key: "amount", width: 18 },
  ];

  ws.mergeCells("A1:C1");
  const title = ws.getCell("A1");
  title.value = `${company.companyName} — Net Position`;
  styleHeader(title);
  title.font = { bold: true, size: 14, color: { argb: COLORS.white } };
  ws.getRow(1).height = 28;

  const summaryRows: Array<[string, number]> = [
    ["What We Have", company.forUsTotal],
    ["What We Owe", company.onUsTotal],
  ];
  if (Math.abs(company.netAdjustment) >= 0.01) summaryRows.push(["Net Position Adjustments", company.netAdjustment]);
  summaryRows.push(["Net Position", company.netPosition]);

  for (const [label, value] of summaryRows) {
    const row = ws.addRow([label, "", value]);
    row.getCell(1).font = { bold: true };
    styleAmount(row.getCell(3), value, label === "Net Position");
  }

  ws.addRow([]);
  const haveHeader = ws.addRow(["WHAT WE HAVE", "Account", "Amount"]);
  haveHeader.eachCell((cell) => styleHeader(cell, COLORS.blue));
  for (const line of company.forUsLines) {
    const row = ws.addRow([line.category || "Other", line.label, line.value]);
    styleAmount(row.getCell(3), line.value);
  }
  const haveTotal = ws.addRow(["TOTAL WHAT WE HAVE", "", company.forUsTotal]);
  haveTotal.getCell(1).font = { bold: true };
  styleAmount(haveTotal.getCell(3), company.forUsTotal, true);

  ws.addRow([]);
  const oweHeader = ws.addRow(["WHAT WE OWE", "Account", "Amount"]);
  oweHeader.eachCell((cell) => styleHeader(cell, COLORS.blue));
  for (const line of company.onUsLines) {
    const row = ws.addRow([line.category || "Other", line.label, line.value]);
    styleAmount(row.getCell(3), line.value);
  }
  const oweTotal = ws.addRow(["TOTAL WHAT WE OWE", "", company.onUsTotal]);
  oweTotal.getCell(1).font = { bold: true };
  styleAmount(oweTotal.getCell(3), company.onUsTotal, true);

  ws.views = [{ state: "frozen", ySplit: 1 }];
}

export async function generateGroupNetPositionExcel(snapshot: GroupNetPositionSnapshot): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "ERP System";
  workbook.created = new Date();

  const summary = workbook.addWorksheet("Group Summary");
  summary.columns = [
    { key: "company", width: 28 },
    { key: "have", width: 18 },
    { key: "owe", width: 18 },
    { key: "adjustment", width: 18 },
    { key: "net", width: 18 },
  ];

  summary.mergeCells("A1:E1");
  const title = summary.getCell("A1");
  title.value = `Group Net Position — As of ${snapshot.asOfDate}`;
  styleHeader(title);
  title.font = { bold: true, size: 15, color: { argb: COLORS.white } };
  summary.getRow(1).height = 30;

  summary.addRow(["Companies included", snapshot.companyCount]);
  summary.addRow(["Excluded", "Properties"]);
  summary.addRow([]);

  const totalRows: Array<[string, number]> = [
    ["Total What We Have", snapshot.totals.forUsTotal],
    ["Total What We Owe", snapshot.totals.onUsTotal],
  ];
  if (Math.abs(snapshot.totals.netAdjustments) >= 0.01) {
    totalRows.push(["Net Position Adjustments", snapshot.totals.netAdjustments]);
  }
  totalRows.push(["GROUP NET POSITION", snapshot.totals.netPosition]);

  for (const [label, value] of totalRows) {
    const row = summary.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    styleAmount(row.getCell(2), value, label === "GROUP NET POSITION");
  }

  summary.addRow([]);
  const header = summary.addRow(["Company", "What We Have", "What We Owe", "Adjustments", "Net Position"]);
  header.eachCell((cell) => styleHeader(cell, COLORS.blue));
  for (const company of snapshot.companies) {
    const row = summary.addRow([
      company.companyName,
      company.forUsTotal,
      company.onUsTotal,
      company.netAdjustment,
      company.netPosition,
    ]);
    styleAmount(row.getCell(2), company.forUsTotal);
    styleAmount(row.getCell(3), company.onUsTotal);
    styleAmount(row.getCell(4), company.netAdjustment);
    styleAmount(row.getCell(5), company.netPosition, true);
  }
  const groupRow = summary.addRow([
    "GROUP TOTAL",
    snapshot.totals.forUsTotal,
    snapshot.totals.onUsTotal,
    snapshot.totals.netAdjustments,
    snapshot.totals.netPosition,
  ]);
  groupRow.eachCell((cell, column) => {
    cell.font = { bold: true };
    if (column >= 2) styleAmount(cell, Number(cell.value || 0), column === 5);
  });
  summary.addRow([]);
  const note = summary.addRow([snapshot.intercompany.note]);
  summary.mergeCells(note.number, 1, note.number, 5);
  note.getCell(1).font = { italic: true };
  note.getCell(1).alignment = { wrapText: true };
  summary.views = [{ state: "frozen", ySplit: 1 }];

  for (const side of ["forUs", "onUs"] as const) {
    const ws = workbook.addWorksheet(side === "forUs" ? "What We Have" : "What We Owe");
    ws.columns = [
      { key: "company", width: 28 },
      { key: "category", width: 24 },
      { key: "account", width: 44 },
      { key: "amount", width: 18 },
    ];
    const h = ws.addRow(["Company", "Category", "Account", "Amount"]);
    h.eachCell((cell) => styleHeader(cell));
    for (const company of snapshot.companies) {
      const lines = side === "forUs" ? company.forUsLines : company.onUsLines;
      for (const line of lines) {
        const row = ws.addRow([company.companyName, line.category || "Other", line.label, line.value]);
        styleAmount(row.getCell(4), line.value);
      }
    }
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  const used = new Set(workbook.worksheets.map((sheet) => sheet.name));
  for (const company of snapshot.companies) addCompanyDetailSheet(workbook, company, used);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
