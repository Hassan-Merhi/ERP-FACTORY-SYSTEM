// Extracted from ./_helpers.ts to keep that module under the source-size cap.
import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";

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
