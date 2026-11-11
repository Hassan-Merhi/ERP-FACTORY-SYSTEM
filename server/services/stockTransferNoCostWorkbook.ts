/** Shared cost-free Truck Trip Excel used by manual transfer sends and approved WhatsApp batches. */
import ExcelJS from "exceljs";
export function excelText(input: unknown, max = 180): string {
  const text = Array.from(
    String(input ?? "")
      .trim()
      .slice(0, max),
    (ch) => {
      const code = ch.charCodeAt(0);
      return code <= 0x1f || code === 0x7f ? " " : ch;
    }
  ).join("");
  // Prevent spreadsheet formula injection even when names come from editable data.
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

export type NoCostItem = { stockItemName: string; sourceLocationName: string; quantity: number };
export async function createNoCostExcel(params: {
  companyName: string;
  destinationName: string;
  transferDate: string;
  items: NoCostItem[];
  /** Only populated for verified, fully approved WhatsApp batches. */
  batchReference?: string;
  approvedOrders?: string[];
}): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Truck Trip");
  sheet.pageSetup = {
    paperSize: 9,
    orientation: "portrait",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };
  sheet.columns = [{ width: 46 }, { width: 20 }, { width: 14 }];
  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: "thin", color: { argb: "FFB0B0B0" } },
    left: { style: "thin", color: { argb: "FFB0B0B0" } },
    bottom: { style: "thin", color: { argb: "FFB0B0B0" } },
    right: { style: "thin", color: { argb: "FFB0B0B0" } },
  };
  const borderRow = (row: ExcelJS.Row) => {
    for (let c = 1; c <= 3; c++) row.getCell(c).border = thinBorder;
  };
  const companyRow = sheet.addRow([excelText(params.companyName), "", ""]);
  sheet.mergeCells("A1:C1");
  companyRow.height = 42;
  companyRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6B7A2C" } };
  companyRow.getCell(1).font = { bold: true, size: 20, color: { argb: "FFFFFFFF" } };
  companyRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  companyRow.getCell(1).border = thinBorder;

  const [year, month, day] = params.transferDate.split("-");
  const friendlyDate = Number(month) + "/" + Number(day) + "/" + year.slice(2);
  const line2 = sheet.addRow(["TRUCK TRIP", "DESTINATION:", excelText(params.destinationName)]);
  line2.height = 26;
  const line3 = sheet.addRow(["", "DATE :", friendlyDate]);
  line3.height = 22;
  sheet.mergeCells("A2:A3");
  borderRow(line2);
  borderRow(line3);
  line2.getCell(1).font = { bold: true, size: 16 };
  line2.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
  for (const r of [line2, line3]) {
    r.getCell(2).font = { bold: true, size: 12 };
    r.getCell(2).alignment = { horizontal: "right", vertical: "middle" };
    r.getCell(3).font = { bold: true, size: 12 };
    r.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
  }
  const header = sheet.addRow(["ITEM  NAME", "LOCATION", "Quantity"]);
  header.height = 22;
  for (let c = 1; c <= 3; c++) {
    const cell = header.getCell(c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD4E89E" } };
    cell.font = { bold: true, size: 12 };
    cell.alignment = { horizontal: c === 1 ? "left" : "center", vertical: "middle" };
  }
  borderRow(header);
  const grouped = new Map<string, NoCostItem[]>();
  for (const item of params.items)
    grouped.set(item.sourceLocationName, [...(grouped.get(item.sourceLocationName) || []), item]);
  for (const [location, items] of grouped) {
    for (const item of items) {
      const row = sheet.addRow([item.stockItemName, location, item.quantity]);
      row.height = 22;
      row.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
      row.getCell(2).alignment = row.getCell(3).alignment = { horizontal: "center", vertical: "middle" };
      borderRow(row);
    }
    const sum = items.reduce((total, x) => total + x.quantity, 0);
    const sub = sheet.addRow(["TOTAL " + location.toUpperCase(), "", sum]);
    sub.height = 24;
    sheet.mergeCells("A" + sub.number + ":B" + sub.number);
    for (let c = 1; c <= 3; c++) {
      sub.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
      sub.getCell(c).font = { bold: true, size: 12 };
      sub.getCell(c).alignment = { horizontal: "center", vertical: "middle" };
    }
    borderRow(sub);
  }
  const total = sheet.addRow(["TOTAL", "", params.items.reduce((s, i) => s + i.quantity, 0)]);
  total.height = 26;
  sheet.mergeCells("A" + total.number + ":B" + total.number);
  for (let c = 1; c <= 3; c++) {
    total.getCell(c).font = { bold: true, size: 14, color: { argb: "FFCC0000" } };
    total.getCell(c).alignment = { horizontal: "center", vertical: "middle" };
  }
  borderRow(total);
  if (params.batchReference && params.approvedOrders?.length) {
    const approved = book.addWorksheet("Approved Orders");
    approved.columns = [{ width: 30 }, { width: 52 }];
    const heading = approved.addRow(["APPROVED STOCK TRANSFER ORDERS", "Batch Reference"]);
    heading.font = { bold: true, color: { argb: "FFFFFFFF" } };
    heading.eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid",
      fgColor: { argb: "FF6B7A2C" } }; });
    approved.addRow(["Batch", excelText(params.batchReference)]);
    approved.addRow(["Destination", excelText(params.destinationName)]);
    approved.addRow(["Date", params.transferDate]);
    approved.addRow([]);
    approved.addRow(["Included Stock Transfer Orders"]);
    for (const number of params.approvedOrders) {
      approved.addRow([excelText(number)]);
    }
    approved.pageSetup = { orientation: "portrait", fitToPage: true, fitToWidth: 1 };
  }
  const bytes = await book.xlsx.writeBuffer();
  return Buffer.from(bytes);
}

