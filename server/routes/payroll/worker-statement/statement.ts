/**
 * workerStatementRoutes: WorkerStatementRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { buildSafeFilename, contentDisposition } from "../../../lib/contentDisposition";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, sql } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { factoryWorkers, factoryPayrolls, factoryWorkerAdvances, companies, companySettings } from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";

export function registerWorkerStatementReadRoutes(app: Express) {
  app.get("/api/factory/workers/:id/statement", requireAuth, async (req: Request, res: Response) => {
    try {
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(workerId)) return res.status(400).json({ message: "Invalid worker ID" });

      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { startDate, endDate } = req.query;

      const advanceConditions = [
        eq(factoryWorkerAdvances.workerId, workerId),
        eq(factoryWorkerAdvances.companyId, companyId),
      ];
      if (startDate) advanceConditions.push(sql`${factoryWorkerAdvances.advanceDate} >= ${startDate}`);
      if (endDate) advanceConditions.push(sql`${factoryWorkerAdvances.advanceDate} <= ${endDate}`);

      const advances = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(and(...advanceConditions))
        .orderBy(factoryWorkerAdvances.advanceDate);

      const payrollConditions = [
        eq(factoryPayrolls.workerId, workerId),
        eq(factoryPayrolls.companyId, companyId),
        eq(factoryPayrolls.status, "PAID"),
      ];
      if (startDate) payrollConditions.push(sql`${factoryPayrolls.paidAt}::date >= ${startDate}`);
      if (endDate) payrollConditions.push(sql`${factoryPayrolls.paidAt}::date <= ${endDate}`);

      const payrolls = await db
        .select()
        .from(factoryPayrolls)
        .where(and(...payrollConditions))
        .orderBy(factoryPayrolls.paidAt);

      type WorkerStatementEntry = {
        entryId: number;
        voucherId: number;
        date: string;
        debitAmount: string;
        creditAmount: string;
        narration: string;
        voucherNumber: string;
        voucherType: string;
        voucherDate: string;
        voucherDescription: string;
        currency: string;
        runningBalance?: number;
      };
      const entries: WorkerStatementEntry[] = [];

      for (const adv of advances) {
        entries.push({
          entryId: adv.id,
          voucherId: adv.id,
          date: adv.advanceDate,
          debitAmount: adv.amount,
          creditAmount: "0",
          narration: adv.notes || "Advance payment",
          voucherNumber: `ADV-${adv.id}`,
          voucherType: "Advance",
          voucherDate: adv.advanceDate,
          voucherDescription: adv.notes || "Advance payment",
          currency: "USD",
        });
      }

      for (const pr of payrolls) {
        const paidDate = pr.paidAt ? new Date(pr.paidAt).toISOString().split("T")[0] : pr.periodEnd;
        entries.push({
          entryId: 100000 + pr.id,
          voucherId: 100000 + pr.id,
          date: paidDate,
          debitAmount: "0",
          creditAmount: pr.netSalary || "0",
          narration: `Payroll ${pr.periodStart} to ${pr.periodEnd}`,
          voucherNumber: `PAY-${pr.id}`,
          voucherType: "Payroll",
          voucherDate: paidDate,
          voucherDescription: `Payroll ${pr.periodStart} to ${pr.periodEnd}`,
          currency: "USD",
        });
      }

      entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      let runningBalance = 0;
      for (const entry of entries) {
        runningBalance += parseFloat(entry.debitAmount || "0") - parseFloat(entry.creditAmount || "0");
        entry.runningBalance = runningBalance;
      }

      res.json(entries);
    } catch (error: unknown) {
      logger.error("Error fetching factory worker statement:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Factory Worker Statement PDF ──────────────────────────────────────────
  app.get("/api/factory/workers/:id/statement-pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(workerId)) return res.status(400).json({ message: "Invalid worker ID" });
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };

      // Worker info
      const [worker] = await db
        .select()
        .from(factoryWorkers)
        .where(and(eq(factoryWorkers.id, workerId), eq(factoryWorkers.companyId, companyId)));
      if (!worker) return res.status(404).json({ message: "Worker not found" });
      const workerName = worker.fullName || `Worker #${workerId}`;

      // Advances
      const advConds = [eq(factoryWorkerAdvances.workerId, workerId), eq(factoryWorkerAdvances.companyId, companyId)];
      if (startDate) advConds.push(sql`${factoryWorkerAdvances.advanceDate} >= ${startDate}`);
      if (endDate) advConds.push(sql`${factoryWorkerAdvances.advanceDate} <= ${endDate}`);
      const advances = await db
        .select()
        .from(factoryWorkerAdvances)
        .where(and(...advConds))
        .orderBy(factoryWorkerAdvances.advanceDate);

      // Payrolls
      const payConds = [
        eq(factoryPayrolls.workerId, workerId),
        eq(factoryPayrolls.companyId, companyId),
        eq(factoryPayrolls.status, "PAID"),
      ];
      if (startDate) payConds.push(sql`${factoryPayrolls.paidAt}::date >= ${startDate}`);
      if (endDate) payConds.push(sql`${factoryPayrolls.paidAt}::date <= ${endDate}`);
      const payrolls = await db
        .select()
        .from(factoryPayrolls)
        .where(and(...payConds))
        .orderBy(factoryPayrolls.paidAt);

      // Build entries
      type WorkerStatementPdfEntry = {
        date: string;
        type: string;
        description: string;
        debit: number;
        credit: number;
      };
      const entries: WorkerStatementPdfEntry[] = [];
      for (const adv of advances) {
        entries.push({
          date: adv.advanceDate,
          type: "Advance",
          description: adv.notes || "Advance payment",
          debit: parseFloat(adv.amount || "0"),
          credit: 0,
        });
      }
      for (const pr of payrolls) {
        const paidDate = pr.paidAt ? new Date(pr.paidAt).toISOString().split("T")[0] : pr.periodEnd;
        entries.push({
          date: paidDate,
          type: "Payroll",
          description: `Payroll ${pr.periodStart} to ${pr.periodEnd}`,
          debit: 0,
          credit: parseFloat(pr.netSalary || "0"),
        });
      }
      entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      let running = 0;
      const rowsWithBalance = entries.map((e) => {
        running += e.debit - e.credit;
        return { ...e, runningBalance: running };
      });

      // Company info
      const [co] = await db.select().from(companies).where(eq(companies.id, companyId));
      const [sett] = await db
        .select()
        .from(companySettings)
        .where(eq(companySettings.companyId, companyId))
        .catch(() => [null]);
      const _companyName = co?.name ?? "Company";
      const _logoUrl: string | null = sett?.logoUrl ?? null;
      const baseCurrency = co?.baseCurrency ?? "USD";
      const currMap: Record<string, string> = { USD: "$ ", GBP: "£", EUR: "€", CFA: "CFA ", AED: "AED " };
      const sym = currMap[baseCurrency.toUpperCase()] ?? baseCurrency + " ";
      const fmtAmt = (n: number) =>
        sym +
        Math.abs(n)
          .toFixed(2)
          .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      const fmtDate = (s: string) =>
        new Date(s.split("T")[0] + "T00:00:00").toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        });
      const periodStr =
        startDate && endDate
          ? `${fmtDate(startDate)} — ${fmtDate(endDate)}`
          : startDate
            ? `From ${fmtDate(startDate)}`
            : endDate
              ? `Up to ${fmtDate(endDate)}`
              : "All Time";
      const generatedStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });

      const PDFDocument = (await import("pdfkit")).default;
      const pathMod = await import("path");

      // Arabic font setup — always register so Arabic names render correctly
      const fontDir = pathMod.join(process.cwd(), "server", "fonts");
      const arabicFontPath = pathMod.join(fontDir, "Amiri-Regular.ttf");
      const hasArabicFont = fs.existsSync(arabicFontPath);

      const doc = new PDFDocument({ margin: 40, size: "A4" });
      if (hasArabicFont) doc.registerFont("Arabic", arabicFontPath);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", contentDisposition(buildSafeFilename(["statement", workerName], "pdf")));
      doc.pipe(res);

      // Arabic reshaping helpers — always loaded
      let wConvertArabic: ((t: string) => string) | null = null;
      let wBidiInst: {
        getEmbeddingLevels: (t: string, d: string) => Record<string, unknown>;
        getReorderedString: (t: string, l: Record<string, unknown>) => string;
      } | null = null;
      try {
        const reshaperMod = require("arabic-reshaper") as { convertArabic: (t: string) => string };
        wConvertArabic = reshaperMod.convertArabic;
        const bidiFactory = require("bidi-js") as () => typeof wBidiInst;
        wBidiInst = bidiFactory();
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }

      const wContainsArabic = (text: string) => /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
      const wShapeText = (text: string): string => {
        if (!text || !wConvertArabic) return text;
        try {
          const reshaped = wConvertArabic(text);
          if (wBidiInst) {
            const levels = wBidiInst.getEmbeddingLevels(reshaped, "rtl");
            return wBidiInst.getReorderedString(reshaped, levels);
          }
          return reshaped;
        } catch {
          return text;
        }
      };

      // Render text with automatic Arabic font switching per cell
      const wRenderText = (text: string, x: number, yPos: number, w: number, align: "left" | "right") => {
        const hasAr = hasArabicFont && wContainsArabic(text);
        doc
          .font(hasAr ? "Arabic" : "Helvetica")
          .fontSize(7.5)
          .text(hasAr ? wShapeText(text) : text, x, yPos, { width: w, align: hasAr ? "right" : align });
      };

      // Header
      const wHmdLogoPath = path.join(process.cwd(), "server", "hmd-logo.png");
      if (fs.existsSync(wHmdLogoPath)) {
        try {
          doc.image(wHmdLogoPath, (doc.page.width - 220) / 2, 20, { width: 220 });
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
      }
      const wNameHasAr = hasArabicFont && wContainsArabic(workerName);
      doc
        .fontSize(10)
        .font(wNameHasAr ? "Arabic" : "Helvetica")
        .fillColor("#555555")
        .text(wNameHasAr ? `كشف حساب: ${wShapeText(workerName)}` : `Account Statement: ${workerName}`, 40, 102, {
          width: 515,
          align: wNameHasAr ? "right" : "center",
        });

      const headerBottom = 110;
      doc
        .moveTo(40, headerBottom + 4)
        .lineTo(555, headerBottom + 4)
        .lineWidth(0.5)
        .strokeColor("#cccccc")
        .stroke();
      doc.lineWidth(1).strokeColor("#000000");

      const metaY = headerBottom + 10;
      doc.fillColor("#444444").fontSize(8).font("Helvetica");
      doc.text(`Period: ${periodStr}`, 40, metaY);
      doc.text(`Generated: ${generatedStr}`, 40, doc.y + 2);
      doc.moveDown(0.5);

      const PAGE_H = 841.89;
      const MARGIN_BOTTOM = 60;
      const colX = [40, 110, 205, 370, 435, 500];
      const colW = [70, 95, 165, 65, 65, 55];
      const colHdr = ["DATE", "TYPE", "PARTICULARS", "DEBIT", "CREDIT", "BALANCE"];
      const colAln: Array<"left" | "right"> = ["left", "left", "left", "right", "right", "right"];
      const ROW_H = 14;
      const HDR_H = 15;

      const drawHdr = (yh: number) => {
        doc.rect(40, yh, 515, HDR_H).fill("#1F3864");
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5);
        colHdr.forEach((h, i) => doc.text(h, colX[i] + 2, yh + 3.5, { width: colW[i] - 4, align: colAln[i] }));
        doc.fillColor("#000000").font("Helvetica").fontSize(7.5);
      };

      const tableY = doc.y + 4;
      drawHdr(tableY);
      let y = tableY + HDR_H;

      // Opening row
      doc.rect(40, y, 515, ROW_H).fill("#F0F4FF");
      doc.fillColor("#000000").font("Helvetica").fontSize(7.5);
      doc.text("Opening Balance", colX[2] + 2, y + 3, { width: colW[2] - 4, align: "left" });
      doc.text("-", colX[3] + 2, y + 3, { width: colW[3] - 4, align: "right" });
      doc.text("-", colX[4] + 2, y + 3, { width: colW[4] - 4, align: "right" });
      doc.text(`${sym}0.00 Dr`, colX[5] + 2, y + 3, { width: colW[5] - 4, align: "right" });
      y += ROW_H;

      // Rows
      rowsWithBalance.forEach((row, idx) => {
        if (y + ROW_H > PAGE_H - MARGIN_BOTTOM) {
          doc.addPage();
          y = 40;
          drawHdr(y);
          y += HDR_H;
        }
        if (idx % 2 === 1) {
          doc.rect(40, y, 515, ROW_H).fill("#F8F8F8");
          doc.fillColor("#000000");
        }
        const bal = row.runningBalance;
        const balSide = bal >= 0 ? "Dr" : "Cr";
        wRenderText(fmtDate(row.date), colX[0] + 2, y + 3, colW[0] - 4, "left");
        wRenderText(row.type, colX[1] + 2, y + 3, colW[1] - 4, "left");
        wRenderText(row.description, colX[2] + 2, y + 3, colW[2] - 4, "left");
        doc.font("Helvetica").fontSize(7.5);
        doc.text(row.debit > 0 ? fmtAmt(row.debit) : "-", colX[3] + 2, y + 3, { width: colW[3] - 4, align: "right" });
        doc.text(row.credit > 0 ? fmtAmt(row.credit) : "-", colX[4] + 2, y + 3, { width: colW[4] - 4, align: "right" });
        doc.text(`${fmtAmt(bal)} ${balSide}`, colX[5] + 2, y + 3, { width: colW[5] - 4, align: "right" });
        y += ROW_H;
      });

      // Footer
      y += 3;
      doc.moveTo(40, y).lineTo(555, y).lineWidth(0.5).strokeColor("#888888").stroke();
      y += 5;
      const totD = rowsWithBalance.reduce((s, r) => s + r.debit, 0);
      const totC = rowsWithBalance.reduce((s, r) => s + r.credit, 0);
      const closing = rowsWithBalance.length > 0 ? rowsWithBalance[rowsWithBalance.length - 1].runningBalance : 0;
      const closingSide = closing >= 0 ? "Dr" : "Cr";

      if (y + 52 > PAGE_H - 20) {
        doc.addPage();
        y = 40;
      }
      doc.rect(40, y, 515, 16).fill("#EFF3FB");
      doc.fillColor("#000000").font("Helvetica").fontSize(8);
      doc.text("Current Period Total", colX[2] + 2, y + 4, { width: colW[2] - 4, align: "left" });
      doc.text(fmtAmt(totD), colX[3] + 2, y + 4, { width: colW[3] - 4, align: "right" });
      doc.text(fmtAmt(totC), colX[4] + 2, y + 4, { width: colW[4] - 4, align: "right" });
      y += 17;
      doc.rect(40, y, 515, 16).fill("#1F3864");
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
      doc.text("Closing Balance", colX[2] + 2, y + 4, { width: colW[2] - 4, align: "left" });
      doc.text(`${fmtAmt(closing)} ${closingSide}`, colX[5] + 2, y + 4, { width: colW[5] - 4, align: "right" });

      doc.end();
    } catch (err: unknown) {
      logger.error("Worker statement PDF error:", { error: err });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(err) });
    }
  });
}
