/**
 * Worker Bales Report PDF Generator (server-side)
 *
 * Generates the same "Worker Bales Report" that StockEntryHistory → Actions →
 * "Worker PDF" produces in the browser, but as a pdfkit Buffer so it can be
 * sent via WhatsApp or downloaded as a proper PDF file.
 *
 * Arabic worker names are rendered using the Amiri font with RTL + shaping.
 */

import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import { plusMoney, toMoney } from "./money";

const FONTS_DIR = path.join(process.cwd(), "server", "fonts");
const AMIRI = path.join(FONTS_DIR, "Amiri-Regular.ttf");
const HAS_AMIRI = fs.existsSync(AMIRI);

const NAVY = "#1e3a8a";
const LIGHT_NAVY = "#2563eb";
const GREY = "#f1f5f9";
const SLATE = "#334155";
const BORDER = "#cbd5e1";

function hex2rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function fill(doc: PDFKit.PDFDocument, hex: string) {
  doc.fillColor(hex2rgb(hex) as [number, number, number]);
}
function stroke(doc: PDFKit.PDFDocument, hex: string) {
  doc.strokeColor(hex2rgb(hex) as [number, number, number]);
}

function isArabic(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

export interface BaleDetail {
  referenceNumber?: string | null;
  workerName?: string | null;
  productName?: string | null;
  articleCode?: string | null;
  weightKg?: string | number | null;
}

export interface GroupRow {
  workerName?: string | null;
  productName?: string | null;
  articleCode?: string | null;
  baleCount?: number;
  totalWeight?: string | number | null;
  bales?: BaleDetail[];
}

export async function generateWorkerBalesPdf(groups: GroupRow[], date: string, companyName = ""): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 32, size: "A4", autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (HAS_AMIRI) doc.registerFont("Amiri", AMIRI);

    const allBales: BaleDetail[] = groups.flatMap((g) => g.bales ?? []);

    const byWorker = new Map<string, BaleDetail[]>();
    for (const b of allBales) {
      const w = b.workerName || "Unassigned";
      if (!byWorker.has(w)) byWorker.set(w, []);
      byWorker.get(w)!.push(b);
    }
    const sortedWorkers = Array.from(byWorker.keys()).sort((a, b) => a.localeCompare(b, "ar"));

    const summaryRows = sortedWorkers
      .map((w) => {
        const bales = byWorker.get(w)!;
        return {
          worker: w,
          count: bales.length,
          totalKg: bales.reduce((s, b) => plusMoney(s, b.weightKg), 0),
        };
      })
      .sort((a, b) => b.count - a.count);

    const grandBales = summaryRows.reduce((s, r) => s + r.count, 0);
    const grandKg = summaryRows.reduce((s, r) => s + r.totalKg, 0);

    const LM = doc.page.margins.left;
    const PAGE_W = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Column widths — more generous for product name, less for weight
    const COL_REF = PAGE_W * 0.15;
    const COL_WKR = PAGE_W * 0.18;
    const COL_PROD = PAGE_W * 0.48;
    const COL_WT = PAGE_W * 0.09;
    const COL_TOT = PAGE_W - COL_REF - COL_WKR - COL_PROD - COL_WT;

    const ROW_H = 18; // taller rows
    const HDR_H = 20;

    let y = doc.page.margins.top;

    // ── Worker name renderer (Arabic-aware) ──────────────────────────────────
    function drawWorkerName(name: string, x: number, ry: number, w: number) {
      const arabic = HAS_AMIRI && isArabic(name);
      if (arabic) {
        doc.font("Amiri").fontSize(9);
        fill(doc, NAVY);
        doc.text(name, x, ry + 1, {
          width: w,
          align: "right",
          features: ["rtla", "arab"] as PDFKit.Mixins.OpenTypeFeatures[] | undefined,
        });
      } else {
        doc.font("Helvetica-Bold").fontSize(8.5);
        fill(doc, NAVY);
        doc.text(name, x + 2, ry + 3, { width: w - 4, lineBreak: false });
      }
      doc.font("Helvetica").fontSize(8.5);
    }

    // ── Page / section header ─────────────────────────────────────────────────
    function drawPageHeader() {
      // Big title
      fill(doc, NAVY);
      doc.font("Helvetica-Bold").fontSize(16);
      doc.text("Worker Bales Report", LM, y);
      y += 22;

      // Sub-line: company · date
      fill(doc, SLATE);
      doc.font("Helvetica").fontSize(8.5);
      const sub = companyName ? `${companyName}  ·  ${date}` : date;
      doc.text(sub, LM, y);
      y += 14;

      // Stats bar: workers | bales | kg
      fill(doc, "#64748b");
      doc.font("Helvetica").fontSize(8.5);
      const stats = `${sortedWorkers.length} workers  |  ${grandBales} BL  |  ${grandKg.toFixed(0)} kg total`;
      doc.text(stats, LM + PAGE_W * 0.5, y - 14, { width: PAGE_W * 0.5, align: "right" });

      // Divider line
      stroke(doc, NAVY);
      doc
        .moveTo(LM, y)
        .lineTo(LM + PAGE_W, y)
        .lineWidth(1.5)
        .stroke();
      y += 8;
    }

    // ── Column header row ─────────────────────────────────────────────────────
    function drawTableHeader() {
      // Header background — light steel blue
      fill(doc, "#dbeafe");
      doc.rect(LM, y, PAGE_W, HDR_H).fill();

      // Header border bottom
      stroke(doc, NAVY);
      doc
        .moveTo(LM, y + HDR_H)
        .lineTo(LM + PAGE_W, y + HDR_H)
        .lineWidth(0.75)
        .stroke();

      doc.font("Helvetica-Bold").fontSize(8);
      fill(doc, NAVY);

      let x = LM;
      doc.text("Reference", x + 3, y + 6, { width: COL_REF - 6, lineBreak: false });
      x += COL_REF;
      doc.text("Worker", x + 3, y + 6, { width: COL_WKR - 6, lineBreak: false });
      x += COL_WKR;
      doc.text("Product", x + 3, y + 6, { width: COL_PROD - 6, lineBreak: false });
      x += COL_PROD;
      doc.text("Weight (kg)", x + 3, y + 6, { width: COL_WT - 4, align: "right", lineBreak: false });
      doc.text("Total / Person", LM + PAGE_W - COL_TOT, y + 6, {
        width: COL_TOT - 4,
        align: "right",
        lineBreak: false,
      });

      y += HDR_H;
    }

    // ── Ensure vertical space ─────────────────────────────────────────────────
    function ensureSpace(needed: number) {
      const bottom = doc.page.height - doc.page.margins.bottom;
      if (y + needed > bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawTableHeader();
      }
    }

    // ── Draw page 1 header + column headers ──────────────────────────────────
    drawPageHeader();
    drawTableHeader();

    // ── Detail rows ───────────────────────────────────────────────────────────
    for (const worker of sortedWorkers) {
      const bales = byWorker.get(worker)!.sort((a, b) => (a.productName || "").localeCompare(b.productName || ""));
      const workerBaleCount = bales.length;
      const workerTotalKg = bales.reduce((s, b) => plusMoney(s, b.weightKg), 0);

      bales.forEach((b, idx) => {
        ensureSpace(ROW_H + 2);

        const isFirst = idx === 0;
        const isLast = idx === bales.length - 1;
        const rowBg = idx % 2 === 0 ? "#ffffff" : GREY;

        // Row background
        fill(doc, rowBg);
        doc.rect(LM, y, PAGE_W, ROW_H).fill();

        // Bottom border
        stroke(doc, BORDER);
        doc
          .moveTo(LM, y + ROW_H)
          .lineTo(LM + PAGE_W, y + ROW_H)
          .lineWidth(0.4)
          .stroke();

        let x = LM;

        // Reference
        doc.font("Courier").fontSize(7.5);
        fill(doc, "#6b7280");
        doc.text(b.referenceNumber || "—", x + 3, y + 5, { width: COL_REF - 6, lineBreak: false });
        x += COL_REF;

        // Worker name (only on first row for this worker)
        if (isFirst) {
          drawWorkerName(worker, x, y, COL_WKR - 4);
        }
        x += COL_WKR;

        // Product — name on one line, article code smaller below if needed
        const prodName = b.productName || "—";
        const artCode = b.articleCode ? ` (${b.articleCode})` : "";
        doc.font("Helvetica").fontSize(8.5);
        fill(doc, SLATE);
        doc.text(prodName + artCode, x + 3, y + 4, { width: COL_PROD - 6, lineBreak: false });
        x += COL_PROD;

        // Weight — number only, right-aligned in COL_WT
        const wt = toMoney(b.weightKg).toFixed(0);
        doc.font("Helvetica").fontSize(8.5);
        fill(doc, SLATE);
        doc.text(wt, x + 2, y + 4, { width: COL_WT - 4, align: "right", lineBreak: false });

        // Total / Person — on last bale row for this worker
        if (isLast) {
          const totX = LM + PAGE_W - COL_TOT;
          // Blue accent left border on the Total column
          stroke(doc, "#bfdbfe");
          doc
            .moveTo(totX, y)
            .lineTo(totX, y + ROW_H)
            .lineWidth(1)
            .stroke();

          // BL count — bold, blue, bigger
          doc.font("Helvetica-Bold").fontSize(10);
          fill(doc, LIGHT_NAVY);
          doc.text(`${workerBaleCount} BL`, totX + 3, y + 2, { width: COL_TOT - 6, align: "right", lineBreak: false });

          // kg total — smaller, muted, below
          doc.font("Helvetica").fontSize(7.5);
          fill(doc, "#64748b");
          doc.text(`${workerTotalKg.toFixed(0)} kg`, totX + 3, y + 10, {
            width: COL_TOT - 6,
            align: "right",
            lineBreak: false,
          });
        }

        y += ROW_H;
      });
    }

    // ── Grand total row ───────────────────────────────────────────────────────
    ensureSpace(ROW_H + 4);
    fill(doc, NAVY);
    doc.rect(LM, y, PAGE_W, ROW_H).fill();
    doc.font("Helvetica-Bold").fontSize(9);
    fill(doc, "#ffffff");
    doc.text("GRAND TOTAL", LM + 3, y + 5, { width: COL_REF + COL_WKR + COL_PROD - 6 });
    doc.text(grandKg.toFixed(0), LM + COL_REF + COL_WKR + COL_PROD + 2, y + 5, { width: COL_WT - 4, align: "right" });
    doc.text(`${grandBales} BL`, LM + PAGE_W - COL_TOT + 3, y + 5, { width: COL_TOT - 6, align: "right" });
    y += ROW_H + 14;

    // ── Worker Summary ────────────────────────────────────────────────────────
    const S_ROW_H = 16;
    const S_HDR_H = 20;
    const S_COL_W = PAGE_W * 0.55;
    const S_COL_B = PAGE_W * 0.2;
    const S_COL_KG = PAGE_W - S_COL_W - S_COL_B;

    const summaryNeeded = S_HDR_H + (summaryRows.length + 1) * S_ROW_H + 50;
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (y + summaryNeeded > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }

    // Summary title bar
    fill(doc, NAVY);
    doc.rect(LM, y, PAGE_W, S_HDR_H + 4).fill();
    doc.font("Helvetica-Bold").fontSize(12);
    fill(doc, "#ffffff");
    doc.text("Worker Summary", LM + 4, y + 7, { width: PAGE_W * 0.5 });
    doc.font("Helvetica").fontSize(8);
    doc.text(`${date}  ·  ${sortedWorkers.length} workers  ·  ${grandBales} BL`, LM + PAGE_W * 0.45, y + 9, {
      width: PAGE_W * 0.5,
      align: "right",
    });
    y += S_HDR_H + 4 + 4;

    // Summary column headers
    fill(doc, "#dbeafe");
    doc.rect(LM, y, PAGE_W, S_HDR_H).fill();
    stroke(doc, NAVY);
    doc
      .moveTo(LM, y + S_HDR_H)
      .lineTo(LM + PAGE_W, y + S_HDR_H)
      .lineWidth(0.75)
      .stroke();
    doc.font("Helvetica-Bold").fontSize(8.5);
    fill(doc, NAVY);
    doc.text("Worker", LM + 4, y + 6, { width: S_COL_W - 8 });
    doc.text("BL", LM + S_COL_W + 2, y + 6, { width: S_COL_B - 4, align: "right" });
    doc.text("Total Weight (kg)", LM + S_COL_W + S_COL_B + 2, y + 6, { width: S_COL_KG - 4, align: "right" });
    y += S_HDR_H;

    summaryRows.forEach((r, idx) => {
      fill(doc, idx % 2 === 0 ? "#ffffff" : GREY);
      doc.rect(LM, y, PAGE_W, S_ROW_H).fill();
      stroke(doc, BORDER);
      doc
        .moveTo(LM, y + S_ROW_H)
        .lineTo(LM + PAGE_W, y + S_ROW_H)
        .lineWidth(0.3)
        .stroke();

      const arabic = HAS_AMIRI && isArabic(r.worker);
      if (arabic) {
        doc.font("Amiri").fontSize(9.5);
        fill(doc, NAVY);
        doc.text(r.worker, LM + 4, y + 3, {
          width: S_COL_W - 8,
          align: "right",
          features: ["rtla", "arab"] as PDFKit.Mixins.OpenTypeFeatures[] | undefined,
        });
      } else {
        doc.font("Helvetica-Bold").fontSize(9);
        fill(doc, SLATE);
        doc.text(r.worker, LM + 4, y + 4, { width: S_COL_W - 8 });
      }

      doc.font("Helvetica-Bold").fontSize(9);
      fill(doc, LIGHT_NAVY);
      doc.text(String(r.count), LM + S_COL_W + 2, y + 4, { width: S_COL_B - 4, align: "right" });

      doc.font("Helvetica").fontSize(9);
      fill(doc, SLATE);
      doc.text(r.totalKg.toFixed(0), LM + S_COL_W + S_COL_B + 2, y + 4, { width: S_COL_KG - 4, align: "right" });
      y += S_ROW_H;
    });

    // Grand total
    fill(doc, NAVY);
    doc.rect(LM, y, PAGE_W, S_ROW_H).fill();
    doc.font("Helvetica-Bold").fontSize(9);
    fill(doc, "#ffffff");
    doc.text("TOTAL", LM + 4, y + 4, { width: S_COL_W - 8 });
    doc.text(String(grandBales), LM + S_COL_W + 2, y + 4, { width: S_COL_B - 4, align: "right" });
    doc.text(grandKg.toFixed(0), LM + S_COL_W + S_COL_B + 2, y + 4, { width: S_COL_KG - 4, align: "right" });

    doc.end();
  });
}
