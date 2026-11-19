import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
import { toArrayBuffer } from "../../lib/bufferCompatibility";
/**
 * Shared state and helpers for the factoryReportRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryReportRoutes.ts.
 */
import ExcelJS from "exceljs";
import fs from "fs";
import { toMoney } from "../../lib/money";
import { hmdLogo, type SupplierUsageBaleRow, type SupplierUsageSummaryRow } from "./_helpersGeneratePdf";
import type { MixSourceRow } from "./_helpersHelpers";
export { generateEmptyPdf, generateEmptyExcel, type MixSourceRow } from "./_helpersHelpers";
export { addPdfBranding, generatePdf, hmdLogo } from "./_helpersGeneratePdf";
export type { SupplierUsageBaleMaterial, SupplierUsageBaleRow, SupplierUsageSummaryRow } from "./_helpersGeneratePdf";

/**
 * Daybook writing plus the PDF and Excel generators for the supplier-usage
 * report.
 *
 * Declared at module scope so the report handlers can live in separate
 * modules; they previously closed over the register function's body.
 */
// Phase 19 C (M3): one shared daybook writer; a missing rate is stored unresolved (0), never 1.
export { writeDaybookEntry } from "../../services/factory/factoryDaybookWriter";

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
        toMoney(ms.weightKg).toNumber(),
      ]);
      row.getCell(5).numFmt = numberFmt;
    } else {
      const row = sheet3.addRow([
        ms.mixBatchId,
        ms.containerId,
        container ? container.containerNumber : `C-${ms.containerId}`,
        supplier ? supplier.name : "Unknown",
        toMoney(ms.weightKg).toNumber(),
        toMoney(ms.costPerKg).toNumber(),
        toMoney(ms.totalCost).toNumber(),
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

  styleUniversalFinancialWorkbook(
    workbook,
    workbook.worksheets.map((ws) => ({ name: ws.name }))
  );
  const xlsBuffer2 = Buffer.from(await workbook.xlsx.writeBuffer());
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="supplier_usage_report_${startDate}_${endDate}.xlsx"`);
  res.setHeader("Content-Length", xlsBuffer2.byteLength);
  res.end(xlsBuffer2);
}
