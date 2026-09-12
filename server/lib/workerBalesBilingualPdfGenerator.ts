import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import type { FactoryCatalogLanguage } from "@shared/factoryBilingualContract";

export interface BilingualWorkerBale {
  referenceNumber?: string | null;
  workerName?: string | null;
  productName?: string | null;
  articleCode?: string | null;
  weightKg?: string | number | null;
}

export interface BilingualWorkerGroup {
  bales?: BilingualWorkerBale[];
}

const ARABIC_FONT_CANDIDATES = [
  path.join(process.cwd(), "server", "fonts", "Amiri-Regular.ttf"),
  path.join(process.cwd(), "server", "fonts", "NotoNaskhArabic-Regular.ttf"),
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

function fontPath(): string | null {
  return ARABIC_FONT_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

const COPY = {
  en: {
    title: "Worker Bales Report",
    reference: "Reference",
    worker: "Worker",
    product: "Product",
    weight: "Weight (kg)",
    total: "Total",
    unassigned: "Unassigned",
    bales: "bales",
  },
  ar: {
    title: "تقرير بالات العمال",
    reference: "المرجع",
    worker: "العامل",
    product: "المنتج",
    weight: "الوزن (كغ)",
    total: "الإجمالي",
    unassigned: "غير محدد",
    bales: "بالات",
  },
  fr: {
    title: "Rapport des balles des travailleurs",
    reference: "Référence",
    worker: "Travailleur",
    product: "Produit",
    weight: "Poids (kg)",
    total: "Total",
    unassigned: "Non attribué",
    bales: "balles",
  },
} as const;

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function generateBilingualWorkerBalesPdf(
  groups: BilingualWorkerGroup[],
  date: string,
  companyName: string,
  language: FactoryCatalogLanguage
): Promise<Buffer> {
  const copy = COPY[language];
  const rtl = language === "ar";
  const arabicFont = fontPath();
  const allBales = groups.flatMap((group) => group.bales ?? []);
  const rows = allBales.sort(
    (a, b) =>
      String(a.workerName ?? "").localeCompare(
        String(b.workerName ?? ""),
        rtl ? "ar" : language === "fr" ? "fr" : "en"
      ) ||
      String(a.productName ?? "").localeCompare(
        String(b.productName ?? ""),
        rtl ? "ar" : language === "fr" ? "fr" : "en"
      )
  );

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 32 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (arabicFont) doc.registerFont("FactoryArabic", arabicFont);
    const pageWidth = doc.page.width - 64;
    const x = 32;
    const rowHeight = 24;
    const columns = [90, 115, 225, 70];
    const align = rtl ? "right" : "left";
    // "arab" is accepted by fontkit at runtime but is not part of the
    // published OpenTypeFeatures union, so the literal array is asserted at
    // the use site (same convention as workerBalesPdfGenerator.ts).
    const textOptions: PDFKit.Mixins.TextOptions =
      rtl && arabicFont ? { align, features: ["rtla", "arab"] as PDFKit.Mixins.OpenTypeFeatures[] } : { align };

    const setFont = (bold = false) => {
      if (rtl && arabicFont) doc.font("FactoryArabic");
      else doc.font(bold ? "Helvetica-Bold" : "Helvetica");
    };

    const drawHeader = () => {
      setFont(true);
      doc.fontSize(16).text(copy.title, x, 32, { width: pageWidth, ...textOptions });
      setFont(false);
      doc.fontSize(9).text(`${companyName} · ${date}`, x, 54, { width: pageWidth, ...textOptions });
      let cx = x;
      const labels = [copy.reference, copy.worker, copy.product, copy.weight];
      doc.rect(x, 72, pageWidth, rowHeight).fill("#E8EEF7");
      setFont(true);
      doc.fillColor("#1F3864").fontSize(8.5);
      labels.forEach((label, index) => {
        doc.text(label, cx + 4, 79, { width: columns[index] - 8, ...textOptions });
        cx += columns[index];
      });
      doc.fillColor("#000000");
      return 96;
    };

    let y = drawHeader();
    let totalWeight = 0;
    rows.forEach((row, index) => {
      if (y + rowHeight > doc.page.height - 48) {
        doc.addPage();
        y = drawHeader();
      }
      if (index % 2 === 1) doc.rect(x, y, pageWidth, rowHeight).fill("#F7F8FA");
      const weight = number(row.weightKg);
      totalWeight += weight;
      const values = [
        row.referenceNumber || "—",
        row.workerName || copy.unassigned,
        `${row.productName || row.articleCode || "—"}${row.articleCode ? ` (${row.articleCode})` : ""}`,
        weight.toLocaleString(undefined, { maximumFractionDigits: 3 }),
      ];
      let cx = x;
      setFont(false);
      doc.fillColor("#263238").fontSize(8.5);
      values.forEach((value, columnIndex) => {
        const valueAlign = columnIndex === 3 ? "right" : align;
        const options: PDFKit.Mixins.TextOptions =
          rtl && arabicFont
            ? {
                width: columns[columnIndex] - 8,
                align: valueAlign,
                features: ["rtla", "arab"] as PDFKit.Mixins.OpenTypeFeatures[],
                lineBreak: false,
              }
            : { width: columns[columnIndex] - 8, align: valueAlign, lineBreak: false };
        doc.text(String(value), cx + 4, y + 7, options);
        cx += columns[columnIndex];
      });
      doc
        .moveTo(x, y + rowHeight)
        .lineTo(x + pageWidth, y + rowHeight)
        .strokeColor("#D9DEE7")
        .lineWidth(0.3)
        .stroke();
      y += rowHeight;
    });

    doc.rect(x, y, pageWidth, rowHeight).fill("#1F3864");
    setFont(true);
    doc.fillColor("#FFFFFF").fontSize(9);
    doc.text(`${copy.total}: ${rows.length} ${copy.bales}`, x + 4, y + 7, { width: pageWidth / 2, ...textOptions });
    doc.text(`${totalWeight.toLocaleString(undefined, { maximumFractionDigits: 3 })} kg`, x + pageWidth / 2, y + 7, {
      width: pageWidth / 2 - 4,
      align: "right",
    });
    doc.end();
  });
}
