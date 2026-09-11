/**
 * factoryBaleExportRoutes: FactoryDailyReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import {
  addInventoryValues,
  inventoryQuantity,
  inventoryUnitCost,
  toInventoryDecimal,
} from "../../../lib/inventoryMath";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getUserHideAllCosts } from "../_helpers";
import { factoryMixBatches, factoryDailyUsages, factorySettings } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import path from "path";
import fs from "fs";

export function registerFactoryDailyReportRoutes(app: Express) {
  app.get("/api/factory/daily-report", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const date = req.query.date as string | undefined;
      const allTime = !date || date === "all";
      const whereClause = allTime
        ? eq(factoryDailyUsages.companyId, companyId)
        : and(eq(factoryDailyUsages.companyId, companyId), sql`${factoryDailyUsages.usedDate} = ${date}`);

      const usages = await db
        .select({
          id: factoryDailyUsages.id,
          mixBatchId: factoryDailyUsages.mixBatchId,
          kgUsed: factoryDailyUsages.kgUsed,
          operatorUser: factoryDailyUsages.operatorUser,
          usedDate: factoryDailyUsages.usedDate,
          notes: factoryDailyUsages.notes,
          createdAt: factoryDailyUsages.createdAt,
          batchCode: factoryMixBatches.batchCode,
          batchName: factoryMixBatches.name,
          costPerKg: factoryMixBatches.costPerKg,
        })
        .from(factoryDailyUsages)
        .innerJoin(factoryMixBatches, eq(factoryDailyUsages.mixBatchId, factoryMixBatches.id))
        .where(whereClause)
        .orderBy(factoryDailyUsages.usedDate, factoryDailyUsages.createdAt);

      const totalKgUsed = addInventoryValues(...usages.map((usage) => usage.kgUsed));
      res.json({ date: allTime ? "all" : date, allTime, usages, totalKgUsed: inventoryQuantity(totalKgUsed) });
    } catch (error: unknown) {
      logger.error("Error fetching daily report:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/daily-report/export", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const dateParam = req.query.date as string | undefined;
      const format = (req.query.format as string) || "excel";
      const allTime = !dateParam || dateParam === "all";
      const filenameDate = allTime ? "all-time" : dateParam;
      const whereClause = allTime
        ? eq(factoryDailyUsages.companyId, companyId)
        : and(eq(factoryDailyUsages.companyId, companyId), sql`${factoryDailyUsages.usedDate} = ${dateParam}`);

      const usages = await db
        .select({
          id: factoryDailyUsages.id,
          mixBatchId: factoryDailyUsages.mixBatchId,
          kgUsed: factoryDailyUsages.kgUsed,
          operatorUser: factoryDailyUsages.operatorUser,
          usedDate: factoryDailyUsages.usedDate,
          notes: factoryDailyUsages.notes,
          createdAt: factoryDailyUsages.createdAt,
          batchCode: factoryMixBatches.batchCode,
          batchName: factoryMixBatches.name,
          costPerKg: factoryMixBatches.costPerKg,
        })
        .from(factoryDailyUsages)
        .innerJoin(factoryMixBatches, eq(factoryDailyUsages.mixBatchId, factoryMixBatches.id))
        .where(whereClause)
        .orderBy(factoryDailyUsages.usedDate, factoryDailyUsages.createdAt);

      const totalKgUsed = addInventoryValues(...usages.map((usage) => usage.kgUsed));
      const [factoryConfig] = await db
        .select({ hideAvgCost: factorySettings.hideAvgCost })
        .from(factorySettings)
        .where(eq(factorySettings.companyId, companyId))
        .limit(1);
      const userHideAllCosts = await getUserHideAllCosts(req);
      const showCost = !factoryConfig?.hideAvgCost && !userHideAllCosts;

      if (format === "excel") {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Production Report");
        const columns: Array<{ header: string; key: string; width: number }> = [
          { header: "Date", key: "date", width: 14 },
          { header: "Batch Code", key: "batchCode", width: 18 },
          { header: "Batch Name", key: "batchName", width: 28 },
          { header: "Operator", key: "operatorUser", width: 20 },
          { header: "KG Used", key: "kgUsed", width: 14 },
        ];
        if (showCost) columns.push({ header: "Cost / KG", key: "costPerKg", width: 14 });
        columns.push({ header: "Notes", key: "notes", width: 32 });
        sheet.columns = columns;

        sheet.getRow(1).eachCell((cell) => {
          cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
        });

        for (const usage of usages) {
          const rowData: {
            date: string;
            batchCode: string;
            batchName: string;
            operatorUser: string;
            kgUsed: number;
            notes: string;
            costPerKg?: number;
          } = {
            date: usage.usedDate,
            batchCode: usage.batchCode,
            batchName: usage.batchName || "",
            operatorUser: usage.operatorUser || "",
            kgUsed: toInventoryDecimal(usage.kgUsed).toNumber(),
            notes: usage.notes || "",
          };
          if (showCost) rowData.costPerKg = toInventoryDecimal(usage.costPerKg).toNumber();
          sheet.addRow(rowData);
        }

        const totalRowData: {
          date: string;
          batchCode: string;
          batchName: string;
          operatorUser: string;
          kgUsed: number;
          notes: string;
          costPerKg?: string;
        } = {
          date: "TOTAL",
          batchCode: "",
          batchName: "",
          operatorUser: "",
          kgUsed: totalKgUsed.toNumber(),
          notes: "",
        };
        if (showCost) totalRowData.costPerKg = "";
        sheet.addRow(totalRowData).eachCell((cell) => {
          cell.font = { bold: true };
        });

        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="raw-production-report-${filenameDate}.xlsx"`);
        res.setHeader("Content-Length", buffer.byteLength);
        return res.end(buffer);
      }

      if (format === "pdf") {
        const PDFDocument = (await import("pdfkit")).default;
        const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="raw-production-report-${filenameDate}.pdf"`);
        doc.pipe(res);

        const logoPath = path.join(process.cwd(), "server", "hmd-logo.png");
        if (fs.existsSync(logoPath)) {
          try {
            doc.image(logoPath, (doc.page.width - 220) / 2, doc.y, { width: 220 });
            doc.moveDown(0.4);
          } catch {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
        }
        doc
          .fontSize(16)
          .font("Helvetica-Bold")
          .text(allTime ? "Raw Production Report — All Time" : "Raw Production Report", { align: "center" });
        if (!allTime) doc.fontSize(11).font("Helvetica").text(`Date: ${dateParam}`, { align: "center" });
        doc.moveDown();

        const columnX = [40, 120, 230, 380, 470, 545, 620];
        const columnWidth = [75, 105, 145, 85, 70, 70, 120];
        const headers = ["Date", "Batch Code", "Batch Name", "Operator", "KG Used", "Cost/KG", "Notes"];
        doc.fontSize(9).font("Helvetica-Bold");
        headers.forEach((header, index) =>
          doc.text(header, columnX[index], doc.y, { continued: index < headers.length - 1, width: columnWidth[index] })
        );
        doc.moveDown(0.3);
        doc.moveTo(40, doc.y).lineTo(752, doc.y).stroke();
        doc.moveDown(0.3);

        doc.font("Helvetica").fontSize(8);
        for (const usage of usages) {
          const y = doc.y;
          const values = [
            usage.usedDate || "—",
            usage.batchCode,
            usage.batchName || "—",
            usage.operatorUser || "—",
            `${inventoryQuantity(usage.kgUsed)} kg`,
            `$${inventoryUnitCost(usage.costPerKg)}`,
            usage.notes || "—",
          ];
          values.forEach((value, index) =>
            doc.text(String(value), columnX[index], y, { width: columnWidth[index], lineBreak: false })
          );
          doc.moveDown(1);
          if (doc.y > doc.page.height - 80) doc.addPage({ layout: "landscape" });
        }

        doc.moveDown(0.5);
        doc.moveTo(40, doc.y).lineTo(752, doc.y).stroke();
        doc.moveDown(0.3);
        doc
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(`Total KG Consumed: ${inventoryQuantity(totalKgUsed)} kg`, { align: "right" });
        doc.end();
        return;
      }

      return res.status(400).json({ message: "Invalid format. Use excel or pdf." });
    } catch (error: unknown) {
      logger.error("Error exporting production report:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
