/**
 * factoryBalesRoutes: BalesExport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";

import { getUserHideAllCosts } from "../_helpers";
import { factoryBales, locations, factorySettings } from "@shared/schema";
import { eq, and, sql, inArray, not } from "drizzle-orm";

export function registerBalesExportRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // 10. Factory Bales queries
  // ───────────────────────────────────────────────

  app.get("/api/factory/bales/export-full.xlsx", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { date } = req.query;
      if (!date) return res.status(400).json({ message: "date query parameter is required (YYYY-MM-DD)" });

      const conditions = [eq(factoryBales.companyId, companyId), sql`${factoryBales.finalizedAt}::date = ${date}`];

      const bales = await db
        .select()
        .from(factoryBales)
        .where(and(...conditions))
        .orderBy(factoryBales.id);

      if (bales.length === 0) {
        return res.status(404).json({ message: `No bales found for date ${date}` });
      }

      const locIds = [...new Set(bales.map((b: any) => b.erpLocationId).filter(Boolean))];
      const locs = locIds.length > 0 ? await db.select().from(locations).where(inArray(locations.id, locIds)) : [];
      const locMap = new Map(locs.map((l: any) => [l.id, l]));

      const [fCfgBale] = await db
        .select({ hideAvgCost: factorySettings.hideAvgCost })
        .from(factorySettings)
        .where(eq(factorySettings.companyId, companyId))
        .limit(1);
      const userHideAllCosts = await getUserHideAllCosts(req);
      const showCostBale = !fCfgBale?.hideAvgCost && !userHideAllCosts;

      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Bales");

      const baleCols = [
        { header: "Reference Number", key: "referenceNumber", width: 22 },
        { header: "Article Code", key: "articleCode", width: 20 },
        { header: "Product Name", key: "productName", width: 30 },
        { header: "Category", key: "category", width: 18 },
        { header: "Weight (kg)", key: "weightKg", width: 14 },
      ];
      if (showCostBale) {
        baleCols.push({ header: "Cost Per Kg", key: "costPerKg", width: 14 });
        baleCols.push({ header: "Total Cost", key: "totalCost", width: 14 });
      }
      baleCols.push(
        { header: "Location Code", key: "locationCode", width: 16 },
        { header: "Location ID", key: "locationId", width: 12 },
        { header: "Status", key: "status", width: 14 },
        { header: "Mix Batch ID", key: "mixBatchId", width: 14 },
        { header: "Bale Code", key: "baleCode", width: 18 },
        { header: "Grade", key: "grade", width: 12 },
        { header: "Finalized At", key: "finalizedAt", width: 22 }
      );
      sheet.columns = baleCols;

      const headerRow = sheet.getRow(1);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2563EB" } };
      });

      for (const bale of bales) {
        const loc = locMap.get(bale.erpLocationId);
        const baleRowData: Record<string, string | number> = {
          referenceNumber: bale.referenceNumber,
          articleCode: bale.articleCode ?? "",
          productName: bale.productName ?? "",
          category: bale.category ?? "",
          weightKg: parseFloat(bale.weightKg || "0"),
        };
        if (showCostBale) {
          baleRowData.costPerKg = parseFloat(bale.costPerKg || "0");
          baleRowData.totalCost = parseFloat(bale.totalCost || "0");
        }
        baleRowData.locationCode = loc ? `${loc.code} - ${loc.name}` : "";
        baleRowData.locationId = bale.erpLocationId ?? "";
        baleRowData.status = bale.status ?? "IN_STOCK";
        baleRowData.mixBatchId = bale.mixBatchId ?? "";
        baleRowData.baleCode = bale.baleCode ?? "";
        baleRowData.grade = bale.grade ?? "";
        baleRowData.finalizedAt = bale.finalizedAt ? new Date(bale.finalizedAt).toISOString() : "";
        sheet.addRow(baleRowData);
      }

      const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="bales_export_${date}.xlsx"`);
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Error exporting full bales:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/factory/bales/stock-register.xlsx — Full stock register: all bales, all statuses
  app.get("/api/factory/bales/stock-register.xlsx", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { from, to } = req.query as { from?: string; to?: string };

      const conditions = [
        eq(factoryBales.companyId, companyId),
        not(inArray(factoryBales.status, ["DELETED", "REMOVED"])),
      ];
      if (from)
        conditions.push(
          sql`COALESCE(${factoryBales.stockEntryDate}, ${factoryBales.createdAt}::date) >= ${from}::date`
        );
      if (to)
        conditions.push(sql`COALESCE(${factoryBales.stockEntryDate}, ${factoryBales.createdAt}::date) <= ${to}::date`);

      const bales = await db
        .select()
        .from(factoryBales)
        .where(and(...conditions))
        .orderBy(factoryBales.createdAt);

      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Factory ERP";
      workbook.created = new Date();

      // ── Sheet 1: All Bales ──
      const sheet = workbook.addWorksheet("Stock Register");

      sheet.columns = [
        { header: "Reference Number", key: "referenceNumber", width: 24 },
        { header: "Article Code", key: "articleCode", width: 18 },
        { header: "Product Name", key: "productName", width: 30 },
        { header: "Category", key: "category", width: 18 },
        { header: "Bale Code", key: "baleCode", width: 18 },
        { header: "Grade", key: "grade", width: 12 },
        { header: "Weight (KG)", key: "weightKg", width: 14 },
        { header: "Status", key: "status", width: 18 },
        { header: "Stock Entry Date", key: "stockEntryDate", width: 18 },
        { header: "Created At", key: "createdAt", width: 22 },
        { header: "Pressed At", key: "pressedAt", width: 22 },
        { header: "Finalized At", key: "finalizedAt", width: 22 },
      ];

      // Style header row
      const headerRow = sheet.getRow(1);
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });
      sheet.getRow(1).height = 22;

      // Status → background colour map
      const statusColors: Record<string, string> = {
        IN_STOCK: "FFD1FAE5",
        SOLD: "FFDBEAFE",
        FINALIZED: "FFDBEAFE",
        DISPATCHED: "FFE0E7FF",
        DELETED: "FFFEE2E2",
        REMOVED: "FFFEE2E2",
        PENDING_PRESSING: "FFFFF9C4",
      };

      for (const bale of bales) {
        const row = sheet.addRow({
          referenceNumber: bale.referenceNumber,
          articleCode: bale.articleCode ?? "",
          productName: bale.productName ?? "",
          category: bale.category ?? "",
          baleCode: bale.baleCode ?? "",
          grade: bale.grade ?? "",
          weightKg: parseFloat(bale.weightKg || "0"),
          status: bale.status ?? "",
          stockEntryDate: bale.stockEntryDate ? new Date(bale.stockEntryDate).toLocaleDateString() : "",
          createdAt: bale.createdAt ? new Date(bale.createdAt).toLocaleString() : "",
          pressedAt: bale.pressedAt ? new Date(bale.pressedAt).toLocaleString() : "",
          finalizedAt: bale.finalizedAt ? new Date(bale.finalizedAt).toLocaleString() : "",
        });

        const bgColor = statusColors[bale.status ?? ""] ?? "FFFFFFFF";
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
        });
      }

      // Weight column — numeric format
      sheet.getColumn("weightKg").numFmt = "#,##0.000";

      // Auto-filter
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
      };

      // ── Sheet 2: Summary by Status ──
      const summarySheet = workbook.addWorksheet("Summary");
      summarySheet.columns = [
        { header: "Status", key: "status", width: 22 },
        { header: "Bale Count", key: "count", width: 14 },
        { header: "Total Weight (KG)", key: "weight", width: 20 },
      ];
      const sumHeader = summarySheet.getRow(1);
      sumHeader.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
      });
      summarySheet.getRow(1).height = 22;

      const statusGroups = new Map<string, { count: number; weight: number }>();
      for (const b of bales) {
        const s = b.status ?? "UNKNOWN";
        const g = statusGroups.get(s) ?? { count: 0, weight: 0 };
        g.count++;
        g.weight += parseFloat(b.weightKg || "0");
        statusGroups.set(s, g);
      }
      for (const [status, g] of statusGroups) {
        const sumRow = summarySheet.addRow({ status, count: g.count, weight: g.weight });
        const bgColor = statusColors[status] ?? "FFFFFFFF";
        sumRow.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
        });
      }
      // Totals row
      const totalRow = summarySheet.addRow({
        status: "TOTAL",
        count: bales.length,
        weight: bales.reduce((s, b) => s + parseFloat(b.weightKg || "0"), 0),
      });
      totalRow.eachCell((cell) => {
        cell.font = { bold: true };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      });
      summarySheet.getColumn("weight").numFmt = "#,##0.000";

      const dateSuffix = from && to ? `_${from}_to_${to}` : `_all`;
      const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="stock_register${dateSuffix}.xlsx"`);
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Error exporting stock register:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
