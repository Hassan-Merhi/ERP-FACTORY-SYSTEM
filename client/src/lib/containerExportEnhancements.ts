import type ExcelJS from "exceljs";

interface ContainerExportLineItem {
  stockItemCode?: string | null;
  stockItemName?: string | null;
  quantity?: string | number | null;
  rate?: string | number | null;
  lineTotal?: string | number | null;
}

interface ContainerExportPurchaseOrder {
  lineItems?: ContainerExportLineItem[] | null;
}

interface ContainerExportPayload {
  container?: {
    containerNumber?: string | null;
    numberPlate?: string | null;
    truckNumber?: string | null;
    supplierCode?: string | null;
    supplierName?: string | null;
  } | null;
  supplier?: {
    code?: string | null;
    legalName?: string | null;
  } | null;
  purchaseOrders?: ContainerExportPurchaseOrder[] | null;
}

interface FullExportRow {
  code: ExcelJS.CellValue;
  name: ExcelJS.CellValue;
  nameText: string;
  quantity: number;
  rate: number;
  value: number;
}

const FULL_EXPORT_HEADERS = ["CODE", "NAME", "QTY", "RATE", "VALUE"] as const;
let workbookEnhancementInstalled = false;

function parseNumber(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function currentContainerId(): string | null {
  const match = window.location.pathname.match(/^\/containers\/(\d+)\/?$/);
  return match?.[1] ?? null;
}

function supplierLabel(data: ContainerExportPayload | null): string {
  return (
    data?.supplier?.code ||
    data?.container?.supplierCode ||
    data?.supplier?.legalName ||
    data?.container?.supplierName ||
    "CONTAINER EXPORT"
  );
}

function containerNumber(data: ContainerExportPayload | null): string {
  return data?.container?.containerNumber || "";
}

function truckNumber(data: ContainerExportPayload | null): string {
  return data?.container?.numberPlate || data?.container?.truckNumber || "";
}

async function fetchContainerExportData(containerId: string): Promise<ContainerExportPayload | null> {
  const response = await fetch(`/api/containers/${containerId}/export`, {
    credentials: "include",
    headers: { "x-bypass-request-storm-guard": "1" },
  });
  if (!response.ok) return null;
  return (await response.json()) as ContainerExportPayload;
}

function applyBorder(cell: ExcelJS.Cell): void {
  cell.border = {
    top: { style: "thin", color: { argb: "FFB8C2CF" } },
    bottom: { style: "thin", color: { argb: "FFB8C2CF" } },
    left: { style: "thin", color: { argb: "FFB8C2CF" } },
    right: { style: "thin", color: { argb: "FFB8C2CF" } },
  };
}

function styleTitleRow(row: ExcelJS.Row): void {
  row.height = 28;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B2A4A" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 13 };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    applyBorder(cell);
  });
}

function styleInfoRow(row: ExcelJS.Row): void {
  row.height = 22;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBDD7EE" } };
    cell.font = { bold: true, size: 11, color: { argb: "FF172033" } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    applyBorder(cell);
  });
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.height = 22;
  row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2E3B4E" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.alignment = {
      horizontal: columnNumber === 3 ? "left" : "center",
      vertical: "middle",
    };
    applyBorder(cell);
  });
}

function isSimpleFullExportSheet(worksheet: ExcelJS.Worksheet): boolean {
  if (worksheet.name !== "Container Items") return false;
  return FULL_EXPORT_HEADERS.every(
    (header, index) => worksheet.getCell(1, index + 1).text.trim().toUpperCase() === header
  );
}

function readFullExportRows(worksheet: ExcelJS.Worksheet): FullExportRow[] {
  const rows: FullExportRow[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    rows.push({
      code: row.getCell(1).value,
      name: row.getCell(2).value,
      nameText: row.getCell(2).text.trim(),
      quantity: parseNumber(row.getCell(3).text),
      rate: parseNumber(row.getCell(4).text),
      value: parseNumber(row.getCell(5).text),
    });
  }
  return rows.sort((left, right) =>
    left.nameText.localeCompare(right.nameText, undefined, { sensitivity: "base", numeric: true })
  );
}

function prepareFullExportSheet(
  worksheet: ExcelJS.Worksheet,
  metadata: ContainerExportPayload | null
): void {
  if (!isSimpleFullExportSheet(worksheet)) return;

  const rows = readFullExportRows(worksheet);
  worksheet.spliceRows(1, worksheet.rowCount);
  worksheet.columns = [
    { key: "no", width: 6 },
    { key: "code", width: 18 },
    { key: "description", width: 52 },
    { key: "qty", width: 12 },
    { key: "rate", width: 14 },
    { key: "total", width: 16 },
  ];

  worksheet.addRow([supplierLabel(metadata), "", "", "", "", ""]);
  worksheet.mergeCells("A1:F1");
  styleTitleRow(worksheet.getRow(1));

  worksheet.addRow([
    `CONTAINER: ${containerNumber(metadata)}`,
    "",
    "",
    "",
    `TRUCK: ${truckNumber(metadata)}`,
    "",
  ]);
  worksheet.mergeCells("A2:D2");
  worksheet.mergeCells("E2:F2");
  styleInfoRow(worksheet.getRow(2));

  worksheet.addRow(["NO", "CODE", "DESCRIPTION", "Q'TY", "RATE", "TOTAL"]);
  styleHeaderRow(worksheet.getRow(3));

  rows.forEach((item, index) => {
    const row = worksheet.addRow([index + 1, item.code, item.name, item.quantity, item.rate, item.value]);
    const even = (index + 1) % 2 === 0;
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      if (even) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F6FC" } };
      }
      cell.font = { size: 10, color: { argb: "FF172033" } };
      cell.alignment = {
        horizontal: columnNumber === 3 ? "left" : "center",
        vertical: "middle",
        wrapText: columnNumber === 3,
      };
      applyBorder(cell);
    });
    row.getCell(4).numFmt = "#,##0.###";
    row.getCell(5).numFmt = "#,##0.00####";
    row.getCell(6).numFmt = "#,##0.00";
  });

  const totalRowNumber = 4 + rows.length;
  const totalRow = worksheet.getRow(totalRowNumber);
  totalRow.getCell(1).value = "TOTAL";
  worksheet.mergeCells(`A${totalRowNumber}:C${totalRowNumber}`);
  totalRow.getCell(4).value = rows.reduce((sum, item) => sum + item.quantity, 0);
  totalRow.getCell(5).value = "TOTAL VALUE";
  totalRow.getCell(6).value = rows.reduce((sum, item) => sum + item.value, 0);
  totalRow.height = 24;
  totalRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B2A4A" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    applyBorder(cell);
  });
  totalRow.getCell(4).numFmt = "#,##0.###";
  totalRow.getCell(6).numFmt = "#,##0.00";

  worksheet.views = [{ state: "frozen", xSplit: 0, ySplit: 3 }];
  worksheet.pageSetup.orientation = "portrait";
  worksheet.pageSetup.fitToPage = true;
  worksheet.pageSetup.fitToWidth = 1;
  worksheet.pageSetup.fitToHeight = 0;
  worksheet.pageSetup.horizontalCentered = true;
  worksheet.pageSetup.printArea = `A1:F${totalRowNumber}`;
  worksheet.pageSetup.printTitlesRow = "1:3";
  worksheet.pageSetup.margins = {
    left: 0.2,
    right: 0.2,
    top: 0.45,
    bottom: 0.45,
    header: 0.15,
    footer: 0.15,
  };
}

async function installWorkbookEnhancement(): Promise<void> {
  if (workbookEnhancementInstalled) return;
  workbookEnhancementInstalled = true;

  const { ExcelJS: ClientExcelJS } = await import("./excelHelper");
  const BaseWorkbook = ClientExcelJS.Workbook;

  class ContainerExportWorkbook extends BaseWorkbook {
    private containerItemsWorksheet: ExcelJS.Worksheet | null = null;
    private fullExportWriteHookInstalled = false;

    override addWorksheet(
      name?: string,
      options?: Partial<ExcelJS.AddWorksheetOptions>
    ): ExcelJS.Worksheet {
      const worksheet = super.addWorksheet(name, options);
      if (name === "Container Items") {
        this.containerItemsWorksheet = worksheet;
        this.installFullExportWriteHook();
      }
      return worksheet;
    }

    private installFullExportWriteHook(): void {
      if (this.fullExportWriteHookInstalled) return;
      this.fullExportWriteHookInstalled = true;
      const previousWriteBuffer = this.xlsx.writeBuffer.bind(this.xlsx);

      this.xlsx.writeBuffer = async () => {
        const worksheet = this.containerItemsWorksheet;
        if (worksheet && isSimpleFullExportSheet(worksheet)) {
          const containerId = currentContainerId();
          const metadata = containerId ? await fetchContainerExportData(containerId).catch(() => null) : null;
          prepareFullExportSheet(worksheet, metadata);
        }
        return previousWriteBuffer();
      };
    }
  }

  (ClientExcelJS as unknown as { Workbook: typeof BaseWorkbook }).Workbook = ContainerExportWorkbook;
}

function flattenNoCostRows(data: ContainerExportPayload): Array<{ description: string; quantity: number }> {
  const rows: Array<{ description: string; quantity: number }> = [];
  for (const purchaseOrder of data.purchaseOrders || []) {
    for (const item of purchaseOrder.lineItems || []) {
      rows.push({
        description: item.stockItemName || "",
        quantity: parseNumber(item.quantity),
      });
    }
  }
  return rows.sort((left, right) =>
    left.description.localeCompare(right.description, undefined, { sensitivity: "base", numeric: true })
  );
}

async function exportNoCostPdf(containerId: string): Promise<void> {
  const data = await fetchContainerExportData(containerId);
  if (!data) throw new Error("Container export data is unavailable");

  const rows = flattenNoCostRows(data);
  const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);
  const { jsPDF } = await import("jspdf");
  const autoTable = (await import("jspdf-autotable")).default;
  const document = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageWidth = document.internal.pageSize.getWidth();
  const left = 10;
  const tableWidth = pageWidth - left * 2;
  const label = supplierLabel(data);
  const number = containerNumber(data);
  const truck = truckNumber(data);

  const drawDocumentHeader = () => {
    document.setFillColor(27, 42, 74);
    document.rect(left, 8, tableWidth, 8, "F");
    document.setTextColor(255, 255, 255);
    document.setFont("helvetica", "bold");
    document.setFontSize(10);
    document.text(label, pageWidth / 2, 13, { align: "center" });

    document.setFillColor(189, 215, 238);
    document.rect(left, 16, tableWidth, 8, "F");
    document.setTextColor(23, 32, 51);
    document.setFontSize(8.5);
    document.text(`CONTAINER: ${number}`, left + 3, 21.3);
    document.text(`TRUCK: ${truck}`, pageWidth - left - 3, 21.3, { align: "right" });
  };

  const bodyRows: Array<[string | number, string, string | number]> = rows.map((row, index) => [
    index + 1,
    row.description,
    row.quantity,
  ]);
  bodyRows.push(["TOTAL Q'TY", "", totalQuantity]);
  const totalRowIndex = bodyRows.length - 1;

  autoTable(document, {
    startY: 28,
    margin: { top: 28, right: left, bottom: 12, left },
    head: [["NO", "DESCRIPTION", "Q'TY"]],
    body: bodyRows,
    theme: "grid",
    tableWidth,
    styles: {
      font: "helvetica",
      fontSize: 8,
      cellPadding: 1.5,
      lineColor: [184, 194, 207],
      lineWidth: 0.15,
      textColor: [23, 32, 51],
      valign: "middle",
    },
    headStyles: {
      fillColor: [46, 59, 78],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      halign: "center",
    },
    alternateRowStyles: { fillColor: [242, 246, 252] },
    columnStyles: {
      0: { cellWidth: 16, halign: "center" },
      1: { cellWidth: tableWidth - 42, halign: "left" },
      2: { cellWidth: 26, halign: "center" },
    },
    didParseCell: (hookData) => {
      if (hookData.section === "body" && hookData.row.index === totalRowIndex) {
        hookData.cell.styles.fillColor = [27, 42, 74];
        hookData.cell.styles.textColor = [255, 255, 255];
        hookData.cell.styles.fontStyle = "bold";
        hookData.cell.styles.halign = hookData.column.index === 2 ? "center" : "right";
      }
    },
    didDrawPage: drawDocumentHeader,
  });

  const safeContainerNumber = (number || containerId).replace(/[^a-zA-Z0-9_-]+/g, "_");
  document.save(`container_${safeContainerNumber}_no_cost.pdf`);
}

const nativePrint = window.print.bind(window);
window.print = () => {
  const containerId = currentContainerId();
  if (!containerId) {
    nativePrint();
    return;
  }
  void exportNoCostPdf(containerId).catch(() => nativePrint());
};

if (currentContainerId()) {
  void installWorkbookEnhancement();
}

document.addEventListener(
  "click",
  (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-testid="button-export-dropdown"]')) {
      void installWorkbookEnhancement();
    }
  },
  true
);
