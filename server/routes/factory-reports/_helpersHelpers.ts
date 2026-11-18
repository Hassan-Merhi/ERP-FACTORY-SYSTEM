// Extracted from ./_helpers.ts
import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
import { toArrayBuffer } from "../../lib/bufferCompatibility";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import fs from "fs";
import { addPdfBranding, hmdLogo } from "./_helpersGeneratePdf";

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

  styleUniversalFinancialWorkbook(workbook, [{ name: "Summary" }]);
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
