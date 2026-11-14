import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
import type { Database } from "../../db";
import { toArrayBuffer } from "../../lib/bufferCompatibility";
import type { Express, Request, Response, RequestHandler } from "express";
import { logAudit } from "../helpers/auditHelpers";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, gte, lte } from "drizzle-orm";
import PDFDocument from "pdfkit";
import path from "path";
import fs from "fs";
import ExcelJS from "exceljs";
import { factoryWorkers, factoryPayrolls, companies } from "@shared/schema";
import { getProductionBonusTotalsForPayrollIds } from "../../services/payroll/productionBonusPayrollService";

function money(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function auditExport(
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

export function registerFactoryPayrollExportRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
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

  app.post("/api/factory/payroll/export-excel", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = Number(req.body?.companyId);
      const startDate = String(req.body?.startDate ?? "");
      const endDate = String(req.body?.endDate ?? "");
      if (!Number.isInteger(companyId) || companyId <= 0 || !startDate || !endDate) {
        return res.status(400).json({ message: "companyId, startDate, and endDate are required" });
      }

      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      const payrollData = await db
        .select({ payroll: factoryPayrolls, worker: factoryWorkers })
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

      const workbook = new ExcelJS.Workbook();
      const logoPath = path.join(process.cwd(), "server", "hmd-logo.png");
      let logoId: number | null = null;
      try {
        if (fs.existsSync(logoPath)) {
          const buffer = fs.readFileSync(logoPath);
          logoId = workbook.addImage({ buffer: toArrayBuffer(buffer), extension: "jpeg" });
        }
      } catch {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }

      function addSheetHeader(sheet: ExcelJS.Worksheet, title: string, numCols: number, logoCenterCol = 0) {
        const logoRow = sheet.addRow([]);
        logoRow.height = 90;
        if (logoId !== null)
          sheet.addImage(logoId, { tl: { col: logoCenterCol, row: 0 }, ext: { width: 300, height: 90 } });
        const nameRow = sheet.addRow([company?.name || "HMD INTERNATIONAL GROUP"]);
        nameRow.getCell(1).font = { bold: true, size: 16, color: { argb: "FF1F3864" } };
        nameRow.getCell(1).alignment = { horizontal: "center" };
        sheet.mergeCells(nameRow.number, 1, nameRow.number, numCols);
        const titleRow = sheet.addRow([title]);
        titleRow.getCell(1).font = { bold: true, size: 12 };
        titleRow.getCell(1).alignment = { horizontal: "center" };
        sheet.mergeCells(titleRow.number, 1, titleRow.number, numCols);
        const periodRow = sheet.addRow([`Period: ${startDate} to ${endDate}`]);
        periodRow.getCell(1).font = { size: 10, color: { argb: "FF555555" } };
        sheet.mergeCells(periodRow.number, 1, periodRow.number, numCols);
        sheet.addRow([]);
      }

      const SUMMARY_COLS = 19;
      const summarySheet = workbook.addWorksheet("Payroll Summary");
      summarySheet.columns = [
        { key: "code", width: 15 },
        { key: "name", width: 25 },
        { key: "position", width: 18 },
        { key: "salaryType", width: 14 },
        { key: "totalDays", width: 13 },
        { key: "presentDays", width: 13 },
        { key: "absentDays", width: 13 },
        { key: "base", width: 14 },
        { key: "bale", width: 14 },
        { key: "kg", width: 14 },
        { key: "ot", width: 14 },
        { key: "productionBonus", width: 16 },
        { key: "otherBonus", width: 14 },
        { key: "deduct", width: 12 },
        { key: "advance", width: 12 },
        { key: "net", width: 14 },
        { key: "balesCount", width: 12 },
        { key: "kgProcessed", width: 14 },
        { key: "status", width: 12 },
      ];
      addSheetHeader(summarySheet, "Payroll Summary", SUMMARY_COLS, 7);
      const headerRow = summarySheet.addRow([
        "Employee Code",
        "Name",
        "Position",
        "Salary Type",
        "Working Days",
        "Present Days",
        "Absent Days",
        "Base Salary",
        "Bale Earnings",
        "KG Earnings",
        "Overtime Pay",
        "Production Bonus",
        "Other Bonus",
        "Deductions",
        "Advances",
        "Net Salary",
        "Bales Count",
        "KG Processed",
        "Status",
      ]);
      headerRow.alignment = { horizontal: "center" };
      headerRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      });

      for (const row of payrollData) {
        const p = row.payroll;
        const w = row.worker;
        const productionBonus = productionTotals.get(p.id)?.approved ?? 0;
        summarySheet.addRow({
          code: w?.employeeCode || "-",
          name: w?.fullName || "-",
          position: w?.position || "-",
          salaryType: w?.salaryType || "-",
          totalDays: p.totalWorkingDays || 0,
          presentDays: money(p.presentDays),
          absentDays: money(p.absentDays),
          base: money(p.baseSalary),
          bale: money(p.baleEarnings),
          kg: money(p.kgEarnings),
          ot: money(p.overtimePay),
          productionBonus,
          otherBonus: Math.max(0, money(p.bonuses) - productionBonus),
          deduct: money(p.deductions),
          advance: money(p.advances),
          net: money(p.netSalary),
          balesCount: p.balesCount || 0,
          kgProcessed: money(p.kgProcessed),
          status: p.status,
        });
      }
      [
        "base",
        "bale",
        "kg",
        "ot",
        "productionBonus",
        "otherBonus",
        "deduct",
        "advance",
        "net",
        "kgProcessed",
        "presentDays",
        "absentDays",
      ].forEach((key) => {
        summarySheet.getColumn(key).numFmt = "#,##0.00";
      });

      const DETAILS_COLS = 12;
      const detailsSheet = workbook.addWorksheet("Worker Details");
      detailsSheet.columns = [
        { key: "code", width: 15 },
        { key: "name", width: 25 },
        { key: "position", width: 18 },
        { key: "department", width: 18 },
        { key: "salaryType", width: 14 },
        { key: "baseSalary", width: 14 },
        { key: "perBaleRate", width: 14 },
        { key: "perKgRate", width: 14 },
        { key: "overtimeRate", width: 14 },
        { key: "phone", width: 16 },
        { key: "dateJoined", width: 14 },
        { key: "paymentMethod", width: 16 },
      ];
      addSheetHeader(detailsSheet, "Worker Details", DETAILS_COLS, 3.5);
      const detailsHeaderRow = detailsSheet.addRow([
        "Employee Code",
        "Full Name",
        "Position",
        "Department",
        "Salary Type",
        "Base Salary",
        "Per Bale Rate",
        "Per KG Rate",
        "Overtime Rate",
        "Phone",
        "Date Joined",
        "Payment Method",
      ]);
      detailsHeaderRow.alignment = { horizontal: "center" };
      detailsHeaderRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      });

      const seenWorkers = new Set<number>();
      for (const row of payrollData) {
        const worker = row.worker;
        if (!worker || seenWorkers.has(worker.id)) continue;
        seenWorkers.add(worker.id);
        detailsSheet.addRow({
          code: worker.employeeCode || "-",
          name: worker.fullName || "-",
          position: worker.position || "-",
          department: worker.department || "-",
          salaryType: worker.salaryType || "-",
          baseSalary: money(worker.baseSalary),
          perBaleRate: money(worker.perBaleRate),
          perKgRate: money(worker.perKgRate),
          overtimeRate: money(worker.overtimeRate),
          phone: worker.phone1 || "-",
          dateJoined: worker.dateJoined || "-",
          paymentMethod: worker.paymentMethod || "-",
        });
      }
      ["baseSalary", "perBaleRate", "perKgRate", "overtimeRate"].forEach((key) => {
        detailsSheet.getColumn(key).numFmt = "#,##0.00";
      });

      styleUniversalFinancialWorkbook(workbook, [
          { name: "Payroll Summary", headerRow: headerRow.number },
          { name: "Worker Details", headerRow: detailsHeaderRow.number },
        ]);
      const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
      await auditExport(req, companyId, "Excel", startDate, endDate);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=payroll_${startDate}_${endDate}.xlsx`);
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Error exporting payroll Excel", { error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
