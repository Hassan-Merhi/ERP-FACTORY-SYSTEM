/**
 * payrollCoreRoutes: PayrollPaymentSummaryPdf endpoints.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { eq, and, inArray } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { factoryWorkers, factoryPayrolls, companies } from "@shared/schema";
import { getFactoryCompanyId } from "./_helpers";
import { minusMoney, plusMoney, toMoney } from "../../../lib/money";
import { getProductionBonusTotalsForPayrollIds } from "../../../services/payroll/productionBonusPayrollService";

export function registerPayrollPaymentSummaryPdfRoutes(app: Express) {
  app.post("/api/factory/payrolls/payment-summary-pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.body.companyId || getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { payrollIds } = req.body;
      if (!payrollIds?.length) return res.status(400).json({ message: "payrollIds required" });

      const payrollRows = await db
        .select()
        .from(factoryPayrolls)
        .where(and(eq(factoryPayrolls.companyId, companyId), inArray(factoryPayrolls.id, payrollIds)));
      if (!payrollRows.length) return res.status(404).json({ message: "No payroll records found" });

      const productionTotals = await getProductionBonusTotalsForPayrollIds(
        db,
        payrollRows.map((payroll) => payroll.id)
      );
      const workerIdList = [...new Set(payrollRows.map((payroll) => payroll.workerId))];
      const workerRows = await db
        .select({ id: factoryWorkers.id, fullName: factoryWorkers.fullName })
        .from(factoryWorkers)
        .where(inArray(factoryWorkers.id, workerIdList));
      const workerMap = new Map(workerRows.map((worker) => [worker.id, worker.fullName]));
      const [companyRow] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId));

      const PDFDocument = (await import("pdfkit")).default;
      const pathMod = await import("path");
      const fontDir = pathMod.join(process.cwd(), "server", "fonts");
      const arabicFontPath = pathMod.join(fontDir, "Amiri-Regular.ttf");
      const hasArabicFont = fs.existsSync(arabicFontPath);
      const doc = new PDFDocument({ margin: 40, size: "A4" });
      if (hasArabicFont) doc.registerFont("Arabic", arabicFontPath);

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => {
        const pdf = Buffer.concat(chunks);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="payment-summary.pdf"`);
        res.send(pdf);
      });

      let convertArabic: ((text: string) => string) | null = null;
      let bidi: {
        getEmbeddingLevels: (text: string, direction: string) => unknown;
        getReorderedString: (text: string, levels: unknown) => string;
      } | null = null;
      try {
        convertArabic = require("arabic-reshaper").convertArabic;
        bidi = require("bidi-js")();
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }

      const containsArabic = (text: string) => /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
      const shapeText = (text: string): string => {
        if (!text || !convertArabic) return text;
        try {
          const reshaped = convertArabic(text);
          if (bidi) {
            const levels = bidi.getEmbeddingLevels(reshaped, "rtl");
            return bidi.getReorderedString(reshaped, levels);
          }
          return reshaped;
        } catch {
          return text;
        }
      };
      const renderText = (
        text: string,
        x: number,
        y: number,
        width: number,
        align: "left" | "right" | "center",
        size = 8
      ) => {
        const arabic = hasArabicFont && containsArabic(text);
        doc
          .font(arabic ? "Arabic" : "Helvetica")
          .fontSize(size)
          .text(arabic ? shapeText(text) : text, x, y, { width, align: arabic ? "right" : align });
      };

      const logoPath = path.join(process.cwd(), "server", "hmd-logo.png");
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, (doc.page.width - 220) / 2, doc.y, { width: 220 });
          doc.moveDown(0.5);
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
      }
      doc
        .fontSize(11)
        .font("Helvetica")
        .text(companyRow?.name || "Company", { align: "center" });
      doc.fontSize(10).text("Payroll Payment Summary", { align: "center" });
      doc.moveDown(0.3);
      doc.fontSize(8).fillColor("#666666").text(`Generated: ${new Date().toLocaleDateString()}`, { align: "center" });
      doc.moveDown(0.8);

      const periods = [...new Set(payrollRows.map((payroll) => `${payroll.periodStart} – ${payroll.periodEnd}`))];
      doc
        .fontSize(8)
        .fillColor("#333333")
        .text(`Period: ${periods.join(", ")}`);
      doc.moveDown(0.5);

      // Name | Present | Absent | Production Bonus | Other Bonus | Net | Signature
      const COL = { name: 40, present: 210, absent: 247, prod: 284, other: 345, amount: 406, signature: 474 };
      const COL_W = { name: 162, present: 32, absent: 32, prod: 56, other: 56, amount: 62, signature: 81 };
      const rowH = 20;
      const tableTop = doc.y;
      doc.rect(40, tableTop, 515, rowH).fill("#1F3864");
      doc.fillColor("#ffffff").fontSize(7).font("Helvetica-Bold");
      doc.text("Worker Name", COL.name, tableTop + 6, { width: COL_W.name });
      doc.text("Pres.", COL.present, tableTop + 6, { width: COL_W.present, align: "center" });
      doc.text("Abs.", COL.absent, tableTop + 6, { width: COL_W.absent, align: "center" });
      doc.text("Prod Bonus", COL.prod, tableTop + 6, { width: COL_W.prod, align: "right" });
      doc.text("Other Bonus", COL.other, tableTop + 6, { width: COL_W.other, align: "right" });
      doc.text("Net", COL.amount, tableTop + 6, { width: COL_W.amount, align: "right" });
      doc.text("Signature", COL.signature, tableTop + 6, { width: COL_W.signature, align: "center" });

      let y = tableTop + rowH;
      let totalNet = 0;
      let totalProduction = 0;
      let totalOther = 0;
      payrollRows.forEach((payroll, index: number) => {
        const name = (workerMap.get(payroll.workerId) as string) || `Worker #${payroll.workerId}`;
        const present = payroll.presentDays != null ? Number(payroll.presentDays) : null;
        const absent = payroll.absentDays != null ? Number(payroll.absentDays) : null;
        const net = toMoney(payroll.netSalary).toNumber();
        const production = productionTotals.get(payroll.id)?.approved ?? 0;
        const other = Math.max(0, minusMoney(toMoney(payroll.bonuses).toNumber(), production));
        totalNet = plusMoney(totalNet, net);
        totalProduction = plusMoney(totalProduction, production);
        totalOther = plusMoney(totalOther, other);

        if (index % 2 === 1) doc.rect(40, y, 515, rowH).fill("#f5f7fa");
        doc.fillColor("#000000");
        renderText(name, COL.name, y + 6, COL_W.name, "left", 7);
        doc.font("Helvetica").fontSize(7);
        doc.text(
          present == null ? "—" : present % 1 === 0 ? present.toFixed(0) : present.toFixed(1),
          COL.present,
          y + 6,
          { width: COL_W.present, align: "center" }
        );
        doc.text(absent == null ? "—" : absent % 1 === 0 ? absent.toFixed(0) : absent.toFixed(1), COL.absent, y + 6, {
          width: COL_W.absent,
          align: "center",
        });
        doc.text(toMoney(production).toFixed(2), COL.prod, y + 6, { width: COL_W.prod, align: "right" });
        doc.text(toMoney(other).toFixed(2), COL.other, y + 6, { width: COL_W.other, align: "right" });
        doc.text(toMoney(net).toFixed(2), COL.amount, y + 6, { width: COL_W.amount, align: "right" });
        const sigY = y + rowH - 5;
        doc
          .moveTo(COL.signature + 5, sigY)
          .lineTo(COL.signature + COL_W.signature - 5, sigY)
          .strokeColor("#aaaaaa")
          .lineWidth(0.5)
          .stroke();
        y += rowH;
      });

      doc.rect(40, y + 2, 515, rowH).fill("#1F3864");
      doc.fillColor("#ffffff").fontSize(7).font("Helvetica-Bold");
      doc.text("TOTAL", COL.name, y + 7, { width: COL_W.name });
      doc.text(toMoney(totalProduction).toFixed(2), COL.prod, y + 7, { width: COL_W.prod, align: "right" });
      doc.text(toMoney(totalOther).toFixed(2), COL.other, y + 7, { width: COL_W.other, align: "right" });
      doc.text(toMoney(totalNet).toFixed(2), COL.amount, y + 7, { width: COL_W.amount, align: "right" });
      doc.end();
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
