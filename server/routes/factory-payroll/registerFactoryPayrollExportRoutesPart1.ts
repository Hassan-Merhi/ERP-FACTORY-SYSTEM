// Extracted from ./exports.ts
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { logAudit } from "../helpers/auditHelpers";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, gte, lte } from "drizzle-orm";
import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import { factoryWorkers, factoryPayrolls, companies } from "@shared/schema";
import { getProductionBonusTotalsForPayrollIds } from "../../services/payroll/productionBonusPayrollService";

export function money(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function auditExport(
  req: import("express").Request,
  companyId: number,
  type: "PDF" | "Excel",
  startDate: string,
  endDate: string
) {
  try {
    await logAudit({
      userId: req.session.userId!,
      username: req.session.username || req.session.userId!,
      companyId,
      action: "export",
      tableName: "factory_payrolls",
      recordId: null,
      recordIdentifier: `${type} export — period ${startDate} to ${endDate}`,
      changes: null,
    });
  } catch (auditErr) {
    logger.error(`[payroll export-${type.toLowerCase()} audit] non-fatal`, { error: auditErr });
  }
}

export function registerFactoryPayrollExportRoutesPart1(app: Express, requireAuth: RequestHandler, db: Database) {
  app.post("/api/factory/payroll/export-pdf", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = Number(req.body?.companyId);
      const startDate = String(req.body?.startDate ?? "");
      const endDate = String(req.body?.endDate ?? "");
      if (!Number.isInteger(companyId) || companyId <= 0 || !startDate || !endDate) {
        return res.status(400).json({ message: "companyId, startDate, and endDate are required" });
      }

      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      const payrollData = await db
        .select({
          payroll: factoryPayrolls,
          workerName: factoryWorkers.fullName,
          workerCode: factoryWorkers.employeeCode,
          workerPosition: factoryWorkers.position,
        })
        .from(factoryPayrolls)
        .leftJoin(factoryWorkers, eq(factoryPayrolls.workerId, factoryWorkers.id))
        .where(
          and(
            eq(factoryPayrolls.companyId, companyId),
            gte(factoryPayrolls.periodStart, startDate),
            lte(factoryPayrolls.periodEnd, endDate)
          )
        )
        .orderBy(factoryWorkers.fullName);

      const productionTotals = await getProductionBonusTotalsForPayrollIds(
        db,
        payrollData.map((row) => row.payroll.id)
      );

      const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename=payroll_${startDate}_${endDate}.pdf`);
      await auditExport(req, companyId, "PDF", startDate, endDate);
      doc.pipe(res);

      const hmdLogoPath = path.join(process.cwd(), "server", "hmd-logo.png");
      if (fs.existsSync(hmdLogoPath)) {
        try {
          doc.image(hmdLogoPath, (doc.page.width - 220) / 2, doc.y, { width: 220 });
          doc.moveDown(0.5);
        } catch {
          // Failure here is non-fatal and the surrounding flow continues deliberately.
        }
      }
      doc
        .fontSize(12)
        .font("Helvetica")
        .text(company?.name || "HMD INTERNATIONAL GROUP", { align: "center" });
      doc.fontSize(11).text("Factory Payroll Report", { align: "center" });
      doc.fontSize(9).text(`Period: ${startDate} to ${endDate}`, { align: "center" });
      doc.moveDown(1);

      const headers = [
        "Code",
        "Name",
        "Days",
        "Absent",
        "Base",
        "Bale",
        "KG",
        "OT",
        "Prod Bonus",
        "Other Bonus",
        "Deduct",
        "Net",
      ];
      const colWidths = [45, 105, 50, 45, 55, 50, 50, 45, 62, 62, 50, 60];
      const startX = 30;
      let y = doc.y;

      doc.fontSize(7).font("Helvetica-Bold");
      let x = startX;
      headers.forEach((header, index) => {
        doc.text(header, x, y, { width: colWidths[index], align: index >= 2 ? "right" : "left" });
        x += colWidths[index];
      });
      y += 15;
      doc
        .moveTo(startX, y)
        .lineTo(startX + colWidths.reduce((sum, width) => sum + width, 0), y)
        .stroke();
      y += 5;
      doc.font("Helvetica").fontSize(7);

      const totals = { base: 0, bale: 0, kg: 0, ot: 0, prodBonus: 0, otherBonus: 0, deduct: 0, net: 0 };
      for (const row of payrollData) {
        const p = row.payroll;
        const base = money(p.baseSalary);
        const bale = money(p.baleEarnings);
        const kg = money(p.kgEarnings);
        const ot = money(p.overtimePay);
        const prodBonus = productionTotals.get(p.id)?.approved ?? 0;
        const otherBonus = Math.max(0, money(p.bonuses) - prodBonus);
        const deduct = money(p.deductions);
        const net = money(p.netSalary);
        const totalDays = p.totalWorkingDays || 0;
        const present = money(p.presentDays);
        const absent = money(p.absentDays);

        totals.base += base;
        totals.bale += bale;
        totals.kg += kg;
        totals.ot += ot;
        totals.prodBonus += prodBonus;
        totals.otherBonus += otherBonus;
        totals.deduct += deduct;
        totals.net += net;

        if (y > 550) {
          doc.addPage();
          y = 30;
        }
        const daysLabel = totalDays > 0 ? `${present % 1 === 0 ? present.toFixed(0) : present}/${totalDays}` : "—";
        const absentLabel = totalDays > 0 ? (absent % 1 === 0 ? absent.toFixed(0) : String(absent)) : "—";
        const values = [
          row.workerCode || "-",
          row.workerName || "-",
          daysLabel,
          absentLabel,
          base.toFixed(2),
          bale.toFixed(2),
          kg.toFixed(2),
          ot.toFixed(2),
          prodBonus.toFixed(2),
          otherBonus.toFixed(2),
          deduct.toFixed(2),
          net.toFixed(2),
        ];
        x = startX;
        values.forEach((value, index) => {
          doc.text(value, x, y, { width: colWidths[index], align: index >= 2 ? "right" : "left" });
          x += colWidths[index];
        });
        y += 12;
      }

      y += 5;
      doc
        .moveTo(startX, y)
        .lineTo(startX + colWidths.reduce((sum, width) => sum + width, 0), y)
        .stroke();
      y += 5;
      doc.font("Helvetica-Bold").fontSize(7);
      const totalValues = [
        "",
        "TOTALS",
        "",
        "",
        totals.base.toFixed(2),
        totals.bale.toFixed(2),
        totals.kg.toFixed(2),
        totals.ot.toFixed(2),
        totals.prodBonus.toFixed(2),
        totals.otherBonus.toFixed(2),
        totals.deduct.toFixed(2),
        totals.net.toFixed(2),
      ];
      x = startX;
      totalValues.forEach((value, index) => {
        doc.text(value, x, y, { width: colWidths[index], align: index >= 2 ? "right" : "left" });
        x += colWidths[index];
      });
      doc.end();
    } catch (error: unknown) {
      logger.error("Error exporting payroll PDF", { error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
