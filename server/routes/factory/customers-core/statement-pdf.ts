/**
 * factoryCustomersRoutes: FactoryCustomerStatementPdf endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { buildSafeFilename, contentDisposition } from "../../../lib/contentDisposition";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  customerOrders,
  customerBalances,
  customers,
  voucherEntries,
  companies,
  companySettings,
  vouchers,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import path from "path";
import fs from "fs";

type StatementVoucherRow = {
  transactionDate: string;
  transactionType: string;
  referenceType: string;
  referenceNumber: string;
  description: string | null;
  debitAmount: string;
  creditAmount: string;
  referenceId?: number | null;
  rowNote?: string | null;
  _fromVoucher: boolean;
};

export function registerFactoryCustomerStatementPdfRoutes(app: Express) {
  // ── Customer Statement: PDF Export ──────────────────────────────────────
  app.get("/api/factory/customers/:id/statement/export-pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });

      const [customer] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      const [settings] = await db.select().from(companySettings).where(eq(companySettings.companyId, companyId));

      const balanceRows = await db
        .select()
        .from(customerBalances)
        .where(and(eq(customerBalances.companyId, companyId), eq(customerBalances.customerId, customerId)))
        .orderBy(customerBalances.transactionDate, customerBalances.id);

      // Pull voucher entries (same logic as statement endpoint)
      const voucherRowsPdf: StatementVoucherRow[] = [];
      const ledgerAccountIdPdf = customer.ledgerAccountId;
      const voucherCondPdf = ledgerAccountIdPdf
        ? sql`(${voucherEntries.ledgerAccountId} = ${ledgerAccountIdPdf} OR ${voucherEntries.customerId} = ${customerId})`
        : sql`${voucherEntries.customerId} = ${customerId}`;
      const rawVePdf = await db
        .select({
          id: voucherEntries.id,
          voucherId: voucherEntries.voucherId,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          description: vouchers.description,
          debitAmount: voucherEntries.debitAmount,
          creditAmount: voucherEntries.creditAmount,
          narration: voucherEntries.narration,
          optional: vouchers.optional,
        })
        .from(voucherEntries)
        .innerJoin(
          vouchers,
          and(
            eq(voucherEntries.voucherId, vouchers.id),
            eq(vouchers.companyId, companyId),
            sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`,
            sql`${vouchers.voucherNumber} NOT LIKE 'INV-%'`
          )
        )
        .where(voucherCondPdf)
        .orderBy(vouchers.voucherDate, voucherEntries.id);
      for (const ve of rawVePdf) {
        if (ve.optional) continue; // optional vouchers don't affect the balance
        voucherRowsPdf.push({
          transactionDate: ve.voucherDate,
          transactionType: ve.voucherType || "VOUCHER",
          referenceType: "VOUCHER",
          referenceNumber: ve.voucherNumber,
          description: ve.narration || ve.description || ve.voucherType,
          debitAmount: ve.debitAmount ?? "0",
          creditAmount: ve.creditAmount ?? "0",
          _fromVoucher: true,
        });
      }
      const allRowsPdf = [...balanceRows.map((r) => ({ ...r, _fromVoucher: false })), ...voucherRowsPdf].sort(
        (a, b) => {
          const da = (a.transactionDate || "").toString(),
            db2 = (b.transactionDate || "").toString();
          if (da !== db2) return da < db2 ? -1 : 1;
          return (a._fromVoucher ? 1 : 0) - (b._fromVoucher ? 1 : 0);
        }
      );

      const openingBalance = parseFloat(customer.openingBalance || "0");
      const openingSide = customer.openingBalanceSide || "Dr";
      let _runningBalance = openingSide === "Dr" ? openingBalance : -openingBalance;

      // Read filter params (forwarded from the frontend export button)
      const dateFromParam = ((req.query.dateFrom as string) || "").trim();
      const dateToParam = ((req.query.dateTo as string) || "").trim();
      const destFilterParam = ((req.query.destination as string) || "").trim().toLowerCase();

      // Build container number + destination maps for INVOICE-type rows
      const invoiceRefIds = [
        ...new Set(
          allRowsPdf.filter((r) => r.referenceType === "INVOICE" && r.referenceId).map((r) => r.referenceId as number)
        ),
      ];
      const containerNumMap = new Map<number, string>();
      const destinationMapPdf = new Map<number, string>();
      if (invoiceRefIds.length > 0) {
        const orderContainers = await db
          .select({
            id: customerOrders.id,
            containerNumber: customerOrders.containerNumber,
            destination: customerOrders.destination,
          })
          .from(customerOrders)
          .where(inArray(customerOrders.id, invoiceRefIds));
        for (const o of orderContainers) {
          if (o.containerNumber) containerNumMap.set(o.id, o.containerNumber);
          if (o.destination) destinationMapPdf.set(o.id, o.destination);
        }
      }

      // First pass: enrich ALL rows with running balance (needed before filtering)
      const allEnrichedPdf = allRowsPdf.map((row) => {
        const debit = parseFloat(row.debitAmount || "0");
        const credit = parseFloat(row.creditAmount || "0");
        _runningBalance += debit - credit;
        let container = "";
        let particulars: string;
        if (row.referenceType === "INVOICE" && row.referenceId) {
          container = containerNumMap.get(row.referenceId) || "";
          particulars = destinationMapPdf.get(row.referenceId) || "";
        } else {
          particulars = row.description || "";
        }
        return { ...row, debit, credit, container, particulars };
      });

      // Compute "brought forward" balance (running balance at the start of the filter period)
      let bfRunning = openingSide === "Dr" ? openingBalance : -openingBalance;
      if (dateFromParam) {
        for (const r of allEnrichedPdf) {
          const rDate = (r.transactionDate || "").toString().slice(0, 10);
          if (rDate < dateFromParam) bfRunning += r.debit - r.credit;
          else break;
        }
      }

      // Apply filters (mirrors frontend filteredHistory logic)
      const rows = allEnrichedPdf.filter((row) => {
        if (destFilterParam) {
          if (!(row.particulars || "").toLowerCase().includes(destFilterParam)) return false;
        }
        if (dateFromParam && row.transactionDate) {
          if ((row.transactionDate || "").toString().slice(0, 10) < dateFromParam) return false;
        }
        if (dateToParam && row.transactionDate) {
          if ((row.transactionDate || "").toString().slice(0, 10) > dateToParam) return false;
        }
        return true;
      });

      const totalDr = rows.reduce((s: number, r) => s + r.debit, 0);
      const totalCr = rows.reduce((s: number, r) => s + r.credit, 0);
      const closingRaw = bfRunning + (totalDr - totalCr);
      const closingBalance = Math.abs(closingRaw);
      const closingBalanceSide = closingRaw >= 0 ? "Dr" : "Cr";

      // Format: $1,234 (no .00 for whole numbers)
      const fmtAmt = (n: number) => {
        if (n <= 0) return "";
        const rounded = Math.round(n * 100) / 100;
        if (Math.abs(rounded - Math.round(rounded)) < 0.005) {
          return `$${Math.round(rounded).toLocaleString("en-US")}`;
        }
        return `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      };
      const fmtBalance = (n: number, side: string) => {
        const rounded = Math.round(n * 100) / 100;
        const numStr =
          Math.abs(rounded - Math.round(rounded)) < 0.005
            ? `$${Math.round(rounded).toLocaleString("en-US")}`
            : `$${rounded.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        return `${numStr} ${side}`;
      };
      const fmtDate = (d: string) => {
        if (!d) return "";
        const [y, m, day] = d.split("-");
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return `${parseInt(day, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
      };
      const txLabel = (type: string) => {
        const map: Record<string, string> = {
          SALE: "Sale",
          PAYMENT: "Payment",
          RECEIPT: "Receipt",
          ADJUSTMENT: "Adjustment",
          JOURNAL: "Journal",
          OPENING_BALANCE: "Opening Bal.",
        };
        return map[type] || type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      };

      const PDFDocument = (await import("pdfkit")).default;
      const pathModCust = await import("path");

      // ── Arabic font ──
      const custFontDir = pathModCust.join(process.cwd(), "server", "fonts");
      const custArabicFontPath = pathModCust.join(custFontDir, "Amiri-Regular.ttf");
      const custHasArabicFont = fs.existsSync(custArabicFontPath);
      const custHmdLogoPath = path.join(process.cwd(), "server", "hmd-logo.png");

      // ── Fetch company logo — prefer companySettings.logoUrl, fall back to disk ──
      let logoBuffer: Buffer | null = null;
      const logoUrl = settings?.logoUrl as string | undefined;
      if (logoUrl) {
        try {
          logoBuffer = await new Promise<Buffer>((resolve, reject) => {
            const proto = logoUrl.startsWith("https") ? require("https") : require("http");
            proto
              .get(logoUrl, (r: import("http").IncomingMessage) => {
                const parts: Buffer[] = [];
                r.on("data", (d: Buffer) => parts.push(d));
                r.on("end", () => resolve(Buffer.concat(parts)));
                r.on("error", reject);
              })
              .on("error", reject);
          });
        } catch {
          logoBuffer = null;
        }
      }
      if (!logoBuffer && fs.existsSync(custHmdLogoPath)) {
        try {
          logoBuffer = fs.readFileSync(custHmdLogoPath);
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
      }

      // ── PDF document ──
      const doc = new PDFDocument({ margin: 40, size: "A4", autoFirstPage: true });
      if (custHasArabicFont) doc.registerFont("Arabic", custArabicFontPath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        contentDisposition(
          buildSafeFilename([customer.legalName || customer.code || String(customerId)], "") + "_Statement.pdf"
        )
      );
      doc.pipe(res);

      // ── Arabic reshaper ──
      let custConvAr: ((t: string) => string) | null = null;
      let custBidi: {
        getEmbeddingLevels: (t: string, d: string) => unknown;
        getReorderedString: (t: string, l: unknown) => string;
      } | null = null;
      try {
        custConvAr = require("arabic-reshaper").convertArabic;
        custBidi = require("bidi-js")();
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }
      const custHasAr = (t: string) => /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(t);
      const custShape = (t: string): string => {
        if (!t || !custConvAr) return t;
        try {
          const r = custConvAr(t);
          if (custBidi) {
            const lv = custBidi.getEmbeddingLevels(r, "rtl");
            return custBidi.getReorderedString(r, lv);
          }
          return r;
        } catch {
          return t;
        }
      };

      // ── Page geometry ──
      const PAGE_W = doc.page.width; // 595
      const MARGIN = 40;
      const CONTENT_W = PAGE_W - MARGIN * 2; // 515
      const SAFE_BOT = doc.page.height - 55; // leave 55 px at bottom

      // ── Column layout: Date | Type | Container | Particulars | Debit | Credit ──
      const colX = [40, 115, 185, 285, 380, 468] as const;
      const colW = [75, 70, 100, 95, 88, 87] as const;
      const colHdr = ["Date", "Type", "Container", "Particulars", "Debit (Dr)", "Credit (Cr)"];
      const colAlignArr: Array<"left" | "right"> = ["left", "left", "left", "left", "right", "right"];

      const CP = 3; // cell horizontal padding each side
      const ROW_PAD = 3; // vertical padding top+bottom per row
      const MIN_ROW = 14; // minimum row height
      const HDR_H = 16; // table column-header height
      const FS = 7.5; // body font size

      let y = MARGIN;

      // ── Helper: wrapping cell render with Arabic support ──
      const cellRender = (text: string, x: number, yPos: number, w: number, align: "left" | "right" = "left") => {
        if (!text) return;
        const ar = custHasArabicFont && custHasAr(text);
        doc
          .font(ar ? "Arabic" : "Helvetica")
          .fontSize(FS)
          .text(ar ? custShape(text) : text, x, yPos, { width: w, align: ar ? "right" : align, lineBreak: true });
      };

      // ── Helper: measure a cell's wrapped height ──
      const cellH = (text: string, w: number): number => {
        if (!text) return 0;
        doc.font("Helvetica").fontSize(FS);
        return doc.heightOfString(text, { width: w });
      };

      // ── Helper: draw table column header (updates y) ──
      const drawTableHdr = () => {
        doc.rect(MARGIN, y, CONTENT_W, HDR_H).fill("#1F3864");
        doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(FS);
        colHdr.forEach((h, i) => {
          doc.text(h, colX[i] + CP, y + 4, { width: colW[i] - CP * 2, align: colAlignArr[i], lineBreak: false });
        });
        doc.fillColor("#000000").font("Helvetica").fontSize(FS);
        y += HDR_H;
      };

      // ── Helper: ensure vertical space; add page + redraw header if needed ──
      const ensureSpace = (needed: number) => {
        if (y + needed > SAFE_BOT) {
          doc.addPage();
          y = MARGIN;
          drawTableHdr();
        }
      };

      // ── Logo — centered, max 180 × 80, aspect-ratio preserved ──
      const LOGO_MAX_W = 180;
      const LOGO_MAX_H = 80;
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, (PAGE_W - LOGO_MAX_W) / 2, 12, { fit: [LOGO_MAX_W, LOGO_MAX_H] });
          y = 12 + LOGO_MAX_H + 6;
        } catch {
          y = 40;
        }
      }

      // ── Company name below logo ──
      doc
        .fillColor("#000000")
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(company?.name || "", MARGIN, y, { width: CONTENT_W, align: "center", lineBreak: false });
      y += 15;

      // ── "Account Statement" banner ──
      doc.rect(MARGIN, y, CONTENT_W, 30).fill("#1F3864");
      doc
        .fillColor("#FFFFFF")
        .font("Helvetica-Bold")
        .fontSize(13)
        .text("Account Statement", MARGIN, y + 8, { width: CONTENT_W, align: "center", lineBreak: false });
      y += 34;

      // ── Customer info line ──
      doc.fillColor("#000000").font("Helvetica").fontSize(9).text("Customer:  ", MARGIN, y, { continued: true });
      const lnm = customer.legalName || "";
      if (custHasArabicFont && custHasAr(lnm)) {
        doc.font("Arabic").fontSize(9).text(custShape(lnm));
      } else {
        doc.font("Helvetica-Bold").fontSize(9).text(lnm);
      }
      y += 14;

      // ── Period / filter info ──
      if (dateFromParam || dateToParam || destFilterParam) {
        const periodParts: string[] = [];
        if (dateFromParam || dateToParam) {
          periodParts.push(
            `Period: ${dateFromParam ? fmtDate(dateFromParam) : "Start"} – ${dateToParam ? fmtDate(dateToParam) : "End"}`
          );
        }
        if (destFilterParam) periodParts.push(`Destination: ${destFilterParam.toUpperCase()}`);
        doc
          .fillColor("#555555")
          .font("Helvetica")
          .fontSize(8)
          .text(periodParts.join("   |   "), MARGIN, y, { width: CONTENT_W, align: "center", lineBreak: false });
        y += 12;
      }
      y += 4;

      // ── Table header ──
      drawTableHdr();

      // ── Balance B/F row (only when date-filtered and there's a prior balance) ──
      if (dateFromParam && Math.abs(bfRunning) > 0.005) {
        const bfAbs = Math.abs(bfRunning);
        const bfSide = bfRunning >= 0 ? "Dr" : "Cr";
        const bfRowH = MIN_ROW + ROW_PAD * 2;
        ensureSpace(bfRowH);
        doc.rect(MARGIN, y, CONTENT_W, bfRowH - 1).fill("#EFF3FB");
        doc.fillColor("#000000").font("Helvetica-Bold").fontSize(FS);
        doc.text("Balance B/F", colX[3] + CP, y + ROW_PAD, { width: colW[3] - CP * 2, lineBreak: false });
        if (bfSide === "Dr") {
          doc.text(fmtAmt(bfAbs), colX[4] + CP, y + ROW_PAD, {
            width: colW[4] - CP * 2,
            align: "right",
            lineBreak: false,
          });
        } else {
          doc.text(fmtAmt(bfAbs), colX[5] + CP, y + ROW_PAD, {
            width: colW[5] - CP * 2,
            align: "right",
            lineBreak: false,
          });
        }
        doc.fillColor("#000000").font("Helvetica").fontSize(FS);
        y += bfRowH;
      }

      // ── Data rows ──
      rows.forEach((row, idx: number) => {
        const cTxt = row.container || "";
        const pTxt = row.particulars || "";

        // Calculate row height from the two wrapping columns
        const rowH = Math.max(MIN_ROW, cellH(cTxt, colW[2] - CP * 2), cellH(pTxt, colW[3] - CP * 2)) + ROW_PAD * 2;

        ensureSpace(rowH);

        // Alternating row background
        if (idx % 2 === 1) {
          doc.rect(MARGIN, y, CONTENT_W, rowH).fill("#F7F8FC");
          doc.fillColor("#000000");
        }

        // Bottom separator
        doc
          .moveTo(MARGIN, y + rowH - 0.5)
          .lineTo(MARGIN + CONTENT_W, y + rowH - 0.5)
          .lineWidth(0.2)
          .strokeColor("#DADADA")
          .stroke();

        doc.font("Helvetica").fontSize(FS).fillColor("#000000");

        // Date
        doc.text(fmtDate(row.transactionDate), colX[0] + CP, y + ROW_PAD, {
          width: colW[0] - CP * 2,
          lineBreak: false,
        });
        // Type
        doc.text(txLabel(row.transactionType), colX[1] + CP, y + ROW_PAD, {
          width: colW[1] - CP * 2,
          lineBreak: false,
        });
        // Container — only for INVOICE rows
        cellRender(cTxt, colX[2] + CP, y + ROW_PAD, colW[2] - CP * 2);
        // Particulars — destination (INVOICE) or narration (others)
        cellRender(pTxt, colX[3] + CP, y + ROW_PAD, colW[3] - CP * 2);
        // Reset font after possible Arabic
        doc.font("Helvetica").fontSize(FS).fillColor("#000000");
        // Debit
        if (row.debit > 0)
          doc.text(fmtAmt(row.debit), colX[4] + CP, y + ROW_PAD, {
            width: colW[4] - CP * 2,
            align: "right",
            lineBreak: false,
          });
        // Credit
        if (row.credit > 0)
          doc.text(fmtAmt(row.credit), colX[5] + CP, y + ROW_PAD, {
            width: colW[5] - CP * 2,
            align: "right",
            lineBreak: false,
          });
        // Row note (kept for backward compat)
        if (row.rowNote) {
          doc
            .fillColor("#666666")
            .font("Helvetica-Oblique")
            .fontSize(6)
            .text(`↳ ${row.rowNote}`, colX[2] + CP + 2, y + rowH - 9, {
              width: colW[2] + colW[3] + colW[4] + colW[5] - CP * 2,
              lineBreak: false,
            });
          doc.fillColor("#000000");
        }

        y += rowH;
      });

      // ── Separator ──
      ensureSpace(55);
      y += 4;
      doc
        .moveTo(MARGIN, y)
        .lineTo(MARGIN + CONTENT_W, y)
        .lineWidth(0.75)
        .strokeColor("#888888")
        .stroke();
      y += 6;

      // ── TOTAL row ──
      ensureSpace(18);
      doc.rect(MARGIN, y, CONTENT_W, 16).fill("#1F3864");
      doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(FS);
      doc.text("TOTAL", colX[2] + CP, y + 4, { width: colW[2] - CP * 2, lineBreak: false });
      doc.text(fmtAmt(totalDr) || "$0", colX[4] + CP, y + 4, {
        width: colW[4] - CP * 2,
        align: "right",
        lineBreak: false,
      });
      doc.text(fmtAmt(totalCr) || "$0", colX[5] + CP, y + 4, {
        width: colW[5] - CP * 2,
        align: "right",
        lineBreak: false,
      });
      y += 18;

      // ── Closing Balance row ──
      ensureSpace(18);
      doc.rect(MARGIN, y, CONTENT_W, 16).fill("#EFF3FB");
      doc.fillColor("#000000").font("Helvetica-Bold").fontSize(FS);
      doc.text("Closing Balance", colX[2] + CP, y + 4, { width: colW[2] - CP * 2, lineBreak: false });
      const closingStr = fmtBalance(closingBalance, closingBalanceSide);
      if (closingBalanceSide === "Dr") {
        doc.text(closingStr, colX[4] + CP, y + 4, { width: colW[4] - CP * 2, align: "right", lineBreak: false });
      } else {
        doc.text(closingStr, colX[5] + CP, y + 4, { width: colW[5] - CP * 2, align: "right", lineBreak: false });
      }
      y += 20;

      // ── Statement note ──
      if (customer.statementNote) {
        doc.font("Helvetica").fontSize(FS);
        const noteH = Math.max(16, doc.heightOfString(customer.statementNote, { width: CONTENT_W - 50 }) + 8);
        ensureSpace(noteH);
        doc.rect(MARGIN, y, CONTENT_W, noteH).fill("#F4F6FB");
        doc
          .fillColor("#333333")
          .font("Helvetica-Bold")
          .fontSize(FS)
          .text("Note:", MARGIN + 2, y + 4, { width: 38, lineBreak: false });
        doc
          .font("Helvetica")
          .fontSize(FS)
          .text(customer.statementNote, MARGIN + 42, y + 4, { width: CONTENT_W - 50, lineBreak: true });
        doc.fillColor("#000000");
      }

      doc.end();
    } catch (error: unknown) {
      logger.error("Error exporting customer statement PDF:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
