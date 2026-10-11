import { toArrayBuffer } from "../../lib/bufferCompatibility";
/**
 * Shared state and helpers for the factoryReportRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryReportRoutes.ts.
 */
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";

/**
 * Daybook writing plus the PDF and Excel generators for the supplier-usage
 * report.
 *
 * Declared at module scope so the report handlers can live in separate
 * modules; they previously closed over the register function's body.
 */
// Phase 19 C (M3): one shared daybook writer; a missing rate is stored unresolved (0), never 1.
export { writeDaybookEntry } from "../../services/factory/factoryDaybookWriter";

export const hmdLogo = path.join(process.cwd(), "server", "hmd-logo.png");
export function addPdfBranding(doc: PDFKit.PDFDocument) {
  if (fs.existsSync(hmdLogo)) {
    try {
      doc.image(hmdLogo, (doc.page.width - 220) / 2, doc.y, { width: 220 });
      doc.moveDown(0.4);
    } catch {
      // Failure here is non-fatal and the surrounding flow continues deliberately.
    }
  }
  doc.font("Helvetica");
}

export function generateEmptyPdf(
  res: import("express").Response,
  companyName: string,
  startDate: string,
  endDate: string
) {
  const doc = new PDFDocument({ margin: 40, size: "A4" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="supplier_usage_report_${startDate}_${endDate}.pdf"`);
  doc.pipe(res);

  addPdfBranding(doc);
  doc.moveDown(0.5);
  doc.fontSize(14).text("Supplier Usage Report", { align: "center" });
  doc.moveDown(0.3);
  doc.fontSize(10).text(`Period: ${startDate} to ${endDate}`, { align: "center" });
  doc.moveDown(2);
  doc.fontSize(12).text("No data found for the selected period and filters.", { align: "center" });

  doc.end();
}

export async function generateEmptyExcel(
  res: import("express").Response,
  companyName: string,
  startDate: string,
  endDate: string
) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Summary");
  let xlLogoId: number | null = null;
  try {
    if (fs.existsSync(hmdLogo)) {
      xlLogoId = workbook.addImage({ buffer: toArrayBuffer(fs.readFileSync(hmdLogo)), extension: "jpeg" });
    }
  } catch {
    // Failure here is non-fatal and the surrounding flow continues deliberately.
  }
  const lr = sheet.addRow([]);
  lr.height = 90;
  if (xlLogoId !== null) sheet.addImage(xlLogoId, { tl: { col: 1.5, row: 0 }, ext: { width: 300, height: 90 } });
  const rn = sheet.addRow(["HMD INTERNATIONAL GROUP"]);
  rn.getCell(1).font = { bold: true, size: 16, color: { argb: "FF1F3864" } };
  rn.getCell(1).alignment = { horizontal: "center" };
  const rnTitle = sheet.addRow(["Supplier Usage Report"]);
  rnTitle.getCell(1).font = { bold: true, size: 13 };
  rnTitle.getCell(1).alignment = { horizontal: "center" };
  sheet.addRow([`Period: ${startDate} to ${endDate}`]);
  sheet.addRow([]);
  sheet.addRow(["No data found for the selected period and filters."]);

  const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="supplier_usage_report_${startDate}_${endDate}.xlsx"`);
  res.setHeader("Content-Length", xlsBuffer.byteLength);
  res.end(xlsBuffer);
}

/** A factory_mix_batch_sources row as the supplier-usage report reads it. */
export type MixSourceRow = {
  mixBatchId: number | null;
  containerId: number | null;
  weightKg: string | null;
  costPerKg: string | null;
  totalCost: string | null;
};

/** One material line contributing to a bale in the supplier-usage report. */
export type SupplierUsageBaleMaterial = {
  containerId: number | null;
  containerNumber: string;
  weightKg: number;
  costPerKg: number;
  totalCost: number;
};

/** One bale row in the supplier-usage report. */
export type SupplierUsageBaleRow = {
  baleId: number;
  baleCode: string | null;
  referenceNumber: string;
  productName: string;
  supplierName: string;
  weightKg: number;
  costPerKg: number;
  totalCost: number;
  date: string;
  materials: SupplierUsageBaleMaterial[];
};

/** One supplier row in the supplier-usage report. */
export type SupplierUsageSummaryRow = {
  supplierId: number;
  supplierName: string;
  openingBalance: number;
  totalPurchasedKg: number;
  totalUsedKg: number;
  remaining: number;
  avgCostPerKg: number;
  costPerBale: number;
  totalBales: number;
  totalCost: number;
  bales: unknown[];
};

export async function generatePdf(
  res: import("express").Response,
  companyName: string,
  startDate: string,
  endDate: string,
  supplierSummaries: SupplierUsageSummaryRow[],
  baleBreakdown: SupplierUsageBaleRow[],
  hideAllCosts: boolean
) {
  const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="supplier_usage_report_${startDate}_${endDate}.pdf"`);
  doc.pipe(res);

  addPdfBranding(doc);
  doc.moveDown(0.3);
  doc.fontSize(14).text("Supplier Usage Report", { align: "center" });
  doc.moveDown(0.2);
  doc.fontSize(9).text(`Period: ${startDate} to ${endDate}`, { align: "center" });
  doc
    .fontSize(8)
    .text(`Generated: ${new Date().toISOString().replace("T", " ").substring(0, 19)}`, { align: "center" });
  doc.moveDown(1);

  doc.fontSize(12).text("Supplier Summary", { underline: true });
  doc.moveDown(0.5);

  const summaryHeaders = hideAllCosts
    ? ["Supplier", "Opening (KG)", "Purchased (KG)", "Used (KG)", "Remaining (KG)", "Total Bales"]
    : [
        "Supplier",
        "Opening (KG)",
        "Purchased (KG)",
        "Used (KG)",
        "Remaining (KG)",
        "Cost/KG",
        "Cost/Bale",
        "Total Bales",
      ];
  const colWidths = hideAllCosts ? [160, 100, 105, 95, 105, 90] : [140, 85, 90, 80, 90, 70, 70, 70];
  const startX = 40;
  let y = doc.y;

  doc.fontSize(8);
  doc.font("Helvetica-Bold");
  let x = startX;
  for (let i = 0; i < summaryHeaders.length; i++) {
    doc.text(summaryHeaders[i], x, y, { width: colWidths[i] });
    x += colWidths[i];
  }
  y += 15;

  doc.font("Helvetica");
  doc.fontSize(7);

  for (const s of supplierSummaries) {
    if (y > 520) {
      doc.addPage();
      y = 40;
    }
    x = startX;
    const row = hideAllCosts
      ? [
          s.supplierName,
          s.openingBalance.toFixed(3),
          s.totalPurchasedKg.toFixed(3),
          s.totalUsedKg.toFixed(3),
          s.remaining.toFixed(3),
          String(s.totalBales),
        ]
      : [
          s.supplierName,
          s.openingBalance.toFixed(3),
          s.totalPurchasedKg.toFixed(3),
          s.totalUsedKg.toFixed(3),
          s.remaining.toFixed(3),
          `$${s.avgCostPerKg.toFixed(4)}`,
          `$${s.costPerBale.toFixed(2)}`,
          String(s.totalBales),
        ];
    for (let i = 0; i < row.length; i++) {
      doc.text(row[i], x, y, { width: colWidths[i] });
      x += colWidths[i];
    }
    y += 13;
  }

  if (baleBreakdown.length > 0) {
    doc.addPage();
    y = 40;

    doc.fontSize(12).font("Helvetica-Bold").text("Mixing Breakdown per Bale", startX, y, { underline: true });
    y += 25;

    const baleHeaders = ["Bale ID", "Bale Code", "Materials", "KG Each", "Total Weight", "Date"];
    const baleColWidths = [60, 80, 220, 130, 90, 100];

    doc.fontSize(8).font("Helvetica-Bold");
    x = startX;
    for (let i = 0; i < baleHeaders.length; i++) {
      doc.text(baleHeaders[i], x, y, { width: baleColWidths[i] });
      x += baleColWidths[i];
    }
    y += 15;

    doc.font("Helvetica").fontSize(7);

    for (const bale of baleBreakdown) {
      if (y > 520) {
        doc.addPage();
        y = 40;
      }

      const materialsStr = bale.materials.map((m) => m.containerNumber).join(", ") || "N/A";
      const kgEachStr = bale.materials.map((m) => m.weightKg.toFixed(3)).join(", ") || "N/A";

      x = startX;
      const baleRow = [
        String(bale.baleId),
        bale.baleCode,
        materialsStr,
        kgEachStr,
        bale.weightKg.toFixed(3),
        bale.date,
      ];
      for (let i = 0; i < baleRow.length; i++) {
        doc.text(baleRow[i] ?? "", x, y, { width: baleColWidths[i] });
        x += baleColWidths[i];
      }
      y += 13;
    }
  }

  doc.end();
}

export async function generateExcel(
  res: import("express").Response,
  companyName: string,
  startDate: string,
  endDate: string,
  supplierSummaries: SupplierUsageSummaryRow[],
  baleBreakdown: SupplierUsageBaleRow[],
  allMixSources: MixSourceRow[],
  containerMap: Map<number, { containerNumber: string; supplierId: number | null }>,
  supplierMap: Map<number, { name: string }>,
  hideAllCosts: boolean
) {
  const workbook = new ExcelJS.Workbook();
  const boldFont = { bold: true };
  const numberFmt = "#,##0.000";
  const moneyFmt = "$#,##0.00";

  let xlLogoId2: number | null = null;
  try {
    if (fs.existsSync(hmdLogo)) {
      xlLogoId2 = workbook.addImage({ buffer: toArrayBuffer(fs.readFileSync(hmdLogo)), extension: "jpeg" });
    }
  } catch {
    // Failure here is non-fatal and the surrounding flow continues deliberately.
  }
  const sheet1 = workbook.addWorksheet("Summary");
  const lr1 = sheet1.addRow([]);
  lr1.height = 90;
  if (xlLogoId2 !== null) sheet1.addImage(xlLogoId2, { tl: { col: 1.5, row: 0 }, ext: { width: 300, height: 90 } });
  const rn1 = sheet1.addRow(["HMD INTERNATIONAL GROUP"]);
  rn1.getCell(1).font = { bold: true, size: 16, color: { argb: "FF1F3864" } };
  rn1.getCell(1).alignment = { horizontal: "center" };
  const rn1Title = sheet1.addRow(["Supplier Usage Report"]);
  rn1Title.getCell(1).font = boldFont;
  rn1Title.getCell(1).alignment = { horizontal: "center" };
  sheet1.addRow([`Period: ${startDate} to ${endDate}`]);
  sheet1.addRow([`Generated: ${new Date().toISOString().replace("T", " ").substring(0, 19)}`]);
  sheet1.addRow([]);

  const summaryHeaderRow = hideAllCosts
    ? sheet1.addRow([
        "Supplier",
        "Opening Balance (KG)",
        "Total Purchased (KG)",
        "Total Used (KG)",
        "Remaining (KG)",
        "Total Bales",
      ])
    : sheet1.addRow([
        "Supplier",
        "Opening Balance (KG)",
        "Total Purchased (KG)",
        "Total Used (KG)",
        "Remaining (KG)",
        "Avg Cost/KG (USD)",
        "Cost/Bale (USD)",
        "Total Bales",
        "Total Cost (USD)",
      ]);
  summaryHeaderRow.font = boldFont;

  for (const s of supplierSummaries) {
    if (hideAllCosts) {
      const row = sheet1.addRow([
        s.supplierName,
        s.openingBalance,
        s.totalPurchasedKg,
        s.totalUsedKg,
        s.remaining,
        s.totalBales,
      ]);
      row.getCell(2).numFmt = numberFmt;
      row.getCell(3).numFmt = numberFmt;
      row.getCell(4).numFmt = numberFmt;
      row.getCell(5).numFmt = numberFmt;
    } else {
      const row = sheet1.addRow([
        s.supplierName,
        s.openingBalance,
        s.totalPurchasedKg,
        s.totalUsedKg,
        s.remaining,
        s.avgCostPerKg,
        s.costPerBale,
        s.totalBales,
        s.totalCost,
      ]);
      row.getCell(2).numFmt = numberFmt;
      row.getCell(3).numFmt = numberFmt;
      row.getCell(4).numFmt = numberFmt;
      row.getCell(5).numFmt = numberFmt;
      row.getCell(6).numFmt = moneyFmt;
      row.getCell(7).numFmt = moneyFmt;
      row.getCell(9).numFmt = moneyFmt;
    }
  }

  sheet1.columns.forEach((col) => {
    let maxLen = 12;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value || "").length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 4, 40);
  });

  const sheet2 = workbook.addWorksheet("Bale Breakdown");
  const baleHeaderRow = hideAllCosts
    ? sheet2.addRow(["Bale ID", "Reference Number", "Bale Code", "Product", "Supplier", "Weight (KG)", "Date"])
    : sheet2.addRow([
        "Bale ID",
        "Reference Number",
        "Bale Code",
        "Product",
        "Supplier",
        "Weight (KG)",
        "Cost/KG (USD)",
        "Total Cost (USD)",
        "Date",
      ]);
  baleHeaderRow.font = boldFont;

  for (const bale of baleBreakdown) {
    if (hideAllCosts) {
      const row = sheet2.addRow([
        bale.baleId,
        bale.referenceNumber,
        bale.baleCode,
        bale.productName,
        bale.supplierName,
        bale.weightKg,
        bale.date,
      ]);
      row.getCell(6).numFmt = numberFmt;
    } else {
      const row = sheet2.addRow([
        bale.baleId,
        bale.referenceNumber,
        bale.baleCode,
        bale.productName,
        bale.supplierName,
        bale.weightKg,
        bale.costPerKg,
        bale.totalCost,
        bale.date,
      ]);
      row.getCell(6).numFmt = numberFmt;
      row.getCell(7).numFmt = moneyFmt;
      row.getCell(8).numFmt = moneyFmt;
    }
  }

  sheet2.columns.forEach((col) => {
    let maxLen = 12;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value || "").length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 4, 40);
  });

  const sheet3 = workbook.addWorksheet("Mixing Details");
  const mixHeaderRow = hideAllCosts
    ? sheet3.addRow(["Mix Batch ID", "Container ID", "Container Number", "Supplier", "Weight (KG)"])
    : sheet3.addRow([
        "Mix Batch ID",
        "Container ID",
        "Container Number",
        "Supplier",
        "Weight (KG)",
        "Cost/KG (USD)",
        "Total Cost (USD)",
      ]);
  mixHeaderRow.font = boldFont;

  for (const ms of allMixSources) {
    const container = ms.containerId !== null ? containerMap.get(ms.containerId) : undefined;
    const supplier = container?.supplierId != null ? supplierMap.get(container.supplierId) : null;
    if (hideAllCosts) {
      const row = sheet3.addRow([
        ms.mixBatchId,
        ms.containerId,
        container ? container.containerNumber : `C-${ms.containerId}`,
        supplier ? supplier.name : "Unknown",
        parseFloat(ms.weightKg || "0"),
      ]);
      row.getCell(5).numFmt = numberFmt;
    } else {
      const row = sheet3.addRow([
        ms.mixBatchId,
        ms.containerId,
        container ? container.containerNumber : `C-${ms.containerId}`,
        supplier ? supplier.name : "Unknown",
        parseFloat(ms.weightKg || "0"),
        parseFloat(ms.costPerKg || "0"),
        parseFloat(ms.totalCost || "0"),
      ]);
      row.getCell(5).numFmt = numberFmt;
      row.getCell(6).numFmt = moneyFmt;
      row.getCell(7).numFmt = moneyFmt;
    }
  }

  sheet3.columns.forEach((col) => {
    let maxLen = 12;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value || "").length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 4, 40);
  });

  const sheet4 = workbook.addWorksheet("Balance Calculation");
  const balHeaderRow = sheet4.addRow([
    "Supplier",
    "Opening Balance (KG)",
    "Purchased (KG)",
    "Used (KG)",
    "Remaining (KG)",
  ]);
  balHeaderRow.font = boldFont;

  for (const s of supplierSummaries) {
    const row = sheet4.addRow([s.supplierName, s.openingBalance, s.totalPurchasedKg, s.totalUsedKg, s.remaining]);
    row.getCell(2).numFmt = numberFmt;
    row.getCell(3).numFmt = numberFmt;
    row.getCell(4).numFmt = numberFmt;
    row.getCell(5).numFmt = numberFmt;
  }

  sheet4.columns.forEach((col) => {
    let maxLen = 12;
    col.eachCell?.({ includeEmpty: false }, (cell) => {
      const len = String(cell.value || "").length;
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(maxLen + 4, 40);
  });

  const xlsBuffer2 = Buffer.from(await workbook.xlsx.writeBuffer());
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="supplier_usage_report_${startDate}_${endDate}.xlsx"`);
  res.setHeader("Content-Length", xlsBuffer2.byteLength);
  res.end(xlsBuffer2);
}
