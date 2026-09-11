/**
 * factoryStockRoutes: FactoryLocationInventoryExport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import ExcelJS from "exceljs";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { getExportPriceVisibility } from "../../../helpers/exportVisibility";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryBales,
  customerOrders,
  customerOrderBales,
  locations,
  factorySettings,
} from "@shared/schema";
import { eq, and, or, inArray } from "drizzle-orm";

export function registerFactoryLocationInventoryExportRoutes(app: Express) {
  // Export ALL locations inventory to Excel — summary + bale detail, wipers/garbage on own sheet
  app.get("/api/factory/location-inventory/export/all", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [fCfgAll] = await db
        .select({ hideAvgCost: factorySettings.hideAvgCost, hideSellingPrice: factorySettings.hideSellingPrice })
        .from(factorySettings)
        .where(eq(factorySettings.companyId, companyId))
        .limit(1);
      const userVisAll = await getExportPriceVisibility(req);
      const includeCost = req.query.includeCost !== "0" && !fCfgAll?.hideAvgCost && !userVisAll.hideCost;

      // Only IN_STOCK — exclude FINALIZED and RESERVED
      const allBalesRaw = await db
        .select()
        .from(factoryBales)
        .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.status, "IN_STOCK")))
        .orderBy(factoryBales.erpLocationId, factoryBales.productName);

      // Exclude bales in active orders: LOADING, PENDING_VERIFICATION, or VERIFIED
      const allBaleIdsRaw = allBalesRaw.map((b) => b.id);
      const loadingBaleIdsAll = new Set<number>();
      if (allBaleIdsRaw.length > 0) {
        const loadingRowsAll = await db
          .select({ baleId: customerOrderBales.baleId })
          .from(customerOrderBales)
          .innerJoin(customerOrders, eq(customerOrderBales.orderId, customerOrders.id))
          .where(
            and(
              or(
                eq(customerOrders.status, "LOADING"),
                eq(customerOrders.status, "PENDING_VERIFICATION"),
                eq(customerOrders.status, "VERIFIED")
              ),
              inArray(customerOrderBales.baleId, allBaleIdsRaw)
            )
          );
        for (const r of loadingRowsAll) loadingBaleIdsAll.add(r.baleId);
      }
      const bales = allBalesRaw.filter((b) => !loadingBaleIdsAll.has(b.id));

      // Build lookup maps
      const locationIds = [...new Set(bales.map((b) => b.erpLocationId).filter((id): id is number => id != null))];
      const locationRecords =
        locationIds.length > 0 ? await db.select().from(locations).where(inArray(locations.id, locationIds)) : [];
      const locationMap = new Map(locationRecords.map((l) => [l.id, l.name]));

      const productIds = [...new Set(bales.map((b) => b.productId).filter((id): id is number => id != null && id > 0))];
      const products =
        productIds.length > 0
          ? await db.select().from(factoryBaleProducts).where(inArray(factoryBaleProducts.id, productIds))
          : [];
      const categoryIds = [...new Set(products.map((p) => p.categoryId).filter((id): id is number => id != null))];
      const categories =
        categoryIds.length > 0
          ? await db
              .select()
              .from(factoryCategories)
              .where(and(eq(factoryCategories.companyId, companyId), inArray(factoryCategories.id, categoryIds)))
          : [];

      const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
      const productCategoryNameMap = new Map(products.map((p) => [p.id, categoryMap.get(p.categoryId!) || ""]));
      const productProductionPriceMap = new Map(products.map((p) => [p.id, parseFloat(p.productionPrice || "0")]));

      const isWiperOrGarbage = (catName: string) => {
        const n = catName.toLowerCase();
        return n.includes("wiper") || n.includes("garbage") || n.includes("rag");
      };

      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Factory System";
      workbook.created = new Date();

      const HEADER_BLUE = "FF1F4E79";
      const HEADER_PURPLE = "FF4B2D7F";
      const HEADER_TEAL = "FF1D5F6A";
      const ROW_ALT = "FFF5F8FF";
      const ROW_WG_ALT = "FFFAF5FF";
      const TOTAL_BG = "FFE8F0FE";
      const _LOC_SEP = "FFDCE6F1"; // light blue for location separator rows
      const NUM_FMT = "#,##0.00";
      const INT_FMT = "#,##0";

      const styleHeaderRow = (row: ExcelJS.Row, argbColor: string) => {
        row.height = 20;
        row.eachCell((cell: ExcelJS.Cell) => {
          cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argbColor } };
          cell.alignment = { vertical: "middle", horizontal: "center" };
          cell.border = { bottom: { style: "medium", color: { argb: "FFD0D0D0" } } };
        });
      };

      const applyDataRow = (row: ExcelJS.Row, isAlt: boolean, altArgb: string) => {
        if (isAlt) {
          row.eachCell({ includeEmpty: false }, (cell: ExcelJS.Cell) => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: altArgb } };
          });
        }
        row.eachCell({ includeEmpty: false }, (cell: ExcelJS.Cell) => {
          cell.alignment = { vertical: "middle" };
        });
      };

      // Group bales by locationId + productId, split main vs wiper/garbage
      type GroupedLocRow = {
        locationName: string;
        articleCode: string;
        productName: string;
        category: string;
        baleCount: number;
        totalWeight: number;
        productionPrice: number;
      };
      const mainGrouped = new Map<string, GroupedLocRow>();
      const wgGrouped = new Map<string, GroupedLocRow>();

      for (const b of bales) {
        const locId = b.erpLocationId ?? 0;
        const pid = b.productId ?? 0;
        const key = `${locId}::${pid}`;
        const weight = parseFloat(String(b.weightKg || "0"));
        const catName = productCategoryNameMap.get(pid) || b.category || "";
        const target = isWiperOrGarbage(catName) ? wgGrouped : mainGrouped;
        const existing = target.get(key);
        if (existing) {
          existing.totalWeight += weight;
          existing.baleCount += 1;
        } else {
          target.set(key, {
            locationName: locationMap.get(locId) || `Location #${locId}`,
            articleCode: b.articleCode || "",
            productName: b.productName || "Unknown",
            category: catName,
            totalWeight: weight,
            baleCount: 1,
            productionPrice: productProductionPriceMap.get(pid) || 0,
          });
        }
      }

      const sortRows = (rows: GroupedLocRow[]) =>
        rows.sort((a, b) => a.locationName.localeCompare(b.locationName) || a.productName.localeCompare(b.productName));

      const mainRows = sortRows(Array.from(mainGrouped.values()));
      const wgRows = sortRows(Array.from(wgGrouped.values()));

      // Helper: build a summary sheet (location-grouped)
      const buildSheet = (
        ws: ExcelJS.Worksheet,
        rows: GroupedLocRow[],
        label: string,
        headerColor: string,
        altColor: string
      ) => {
        const cols: Array<{ header: string; key: string; width: number }> = [
          { header: "Location", key: "locationName", width: 22 },
          { header: "Article Code", key: "articleCode", width: 18 },
          { header: "Product Name", key: "productName", width: 38 },
          { header: "Category", key: "category", width: 22 },
          { header: "Bales", key: "baleCount", width: 10 },
          { header: "Wt/Bale (kg)", key: "weightPerBale", width: 14 },
          { header: "Total KG", key: "totalWeight", width: 14 },
        ];
        if (includeCost) {
          cols.push({ header: "Rate (Cost)", key: "productionPrice", width: 14 });
          cols.push({ header: "Total Cost", key: "totalValue", width: 16 });
        }
        ws.columns = cols;
        styleHeaderRow(ws.getRow(1), headerColor);

        let totalBales = 0,
          totalKg = 0,
          totalValue = 0;
        let lastLoc = "";
        let altIdx = 0;

        for (const row of rows) {
          // Location separator row
          if (row.locationName !== lastLoc && lastLoc !== "") {
            const sepRow = ws.addRow({});
            sepRow.height = 6;
            altIdx = 0;
          }
          if (row.locationName !== lastLoc) {
            lastLoc = row.locationName;
          }

          const wpb = row.baleCount > 0 ? row.totalWeight / row.baleCount : 0;
          const tv = row.productionPrice * row.baleCount;
          totalBales += row.baleCount;
          totalKg += row.totalWeight;
          totalValue += tv;

          const rd: Record<string, string | number> = {
            locationName: row.locationName,
            articleCode: row.articleCode,
            productName: row.productName,
            category: row.category,
            baleCount: row.baleCount,
            weightPerBale: parseFloat(wpb.toFixed(2)),
            totalWeight: parseFloat(row.totalWeight.toFixed(2)),
          };
          if (includeCost) {
            rd.productionPrice = row.productionPrice;
            rd.totalValue = parseFloat(tv.toFixed(2));
          }
          const exRow = ws.addRow(rd);
          applyDataRow(exRow, altIdx % 2 === 1, altColor);
          exRow.getCell("baleCount").numFmt = INT_FMT;
          exRow.getCell("weightPerBale").numFmt = NUM_FMT;
          exRow.getCell("totalWeight").numFmt = NUM_FMT;
          if (includeCost) {
            exRow.getCell("productionPrice").numFmt = NUM_FMT;
            exRow.getCell("totalValue").numFmt = NUM_FMT;
          }
          altIdx++;
        }

        ws.addRow({});
        const td: Record<string, string | number> = {
          locationName: "GRAND TOTAL",
          articleCode: "",
          productName: `${rows.length} ${label} across ${locationRecords.length} locations`,
          category: "",
          baleCount: totalBales,
          weightPerBale: "",
          totalWeight: parseFloat(totalKg.toFixed(2)),
        };
        if (includeCost) {
          td.productionPrice = "";
          td.totalValue = parseFloat(totalValue.toFixed(2));
        }
        const tr = ws.addRow(td);
        tr.font = { bold: true };
        tr.eachCell({ includeEmpty: false }, (cell: ExcelJS.Cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
        });
        tr.getCell("baleCount").numFmt = INT_FMT;
        tr.getCell("totalWeight").numFmt = NUM_FMT;
        if (includeCost) tr.getCell("totalValue").numFmt = NUM_FMT;

        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
        ws.views = [{ state: "frozen", ySplit: 1 }];
      };

      // Sheet 1: Stock Summary (main items)
      const summarySheet = workbook.addWorksheet("Stock Summary");
      buildSheet(summarySheet, mainRows, "products", HEADER_BLUE, ROW_ALT);

      // Sheet 2: Wipers & Garbage
      const wgSheet = workbook.addWorksheet("Wipers & Garbage");
      buildSheet(wgSheet, wgRows, "items", HEADER_PURPLE, ROW_WG_ALT);

      // Sheet 3: Bale Details (main items only — no wipers/garbage)
      const baleSheet = workbook.addWorksheet("Bale Details");
      const baleCols: Array<{ header: string; key: string; width: number }> = [
        { header: "Location", key: "locationName", width: 22 },
        { header: "Bale Ref #", key: "referenceNumber", width: 24 },
        { header: "Article Code", key: "articleCode", width: 18 },
        { header: "Product Name", key: "productName", width: 38 },
        { header: "Category", key: "category", width: 22 },
        { header: "Grade", key: "grade", width: 12 },
        { header: "Weight (kg)", key: "weightKg", width: 14 },
      ];
      if (includeCost) {
        baleCols.push({ header: "Cost/kg", key: "costPerKg", width: 14 });
        baleCols.push({ header: "Total Cost", key: "totalCost", width: 14 });
      }
      baleSheet.columns = baleCols;
      styleHeaderRow(baleSheet.getRow(1), HEADER_TEAL);

      const mainBales = bales.filter((b) => {
        const pid = b.productId ?? 0;
        const cat = productCategoryNameMap.get(pid) || b.category || "";
        return !isWiperOrGarbage(cat);
      });

      mainBales.forEach((b, idx) => {
        const locId = b.erpLocationId ?? 0;
        const pid = b.productId ?? 0;
        const rd: Record<string, string | number> = {
          locationName: locationMap.get(locId) || `Location #${locId}`,
          referenceNumber: b.referenceNumber,
          articleCode: b.articleCode || "",
          productName: b.productName || "",
          category: productCategoryNameMap.get(pid) || b.category || "",
          grade: b.grade || "",
          weightKg: parseFloat(String(b.weightKg || "0")),
        };
        if (includeCost) {
          rd.costPerKg = parseFloat(String(b.costPerKg || "0"));
          rd.totalCost = parseFloat(String(b.totalCost || "0"));
        }
        const exRow = baleSheet.addRow(rd);
        applyDataRow(exRow, idx % 2 === 1, ROW_ALT);
        exRow.getCell("weightKg").numFmt = NUM_FMT;
        if (includeCost) {
          exRow.getCell("costPerKg").numFmt = NUM_FMT;
          exRow.getCell("totalCost").numFmt = NUM_FMT;
        }
      });

      baleSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: baleCols.length } };
      baleSheet.views = [{ state: "frozen", ySplit: 1 }];

      // Sheet 4: Garbage & Wiper Bale Details (individual ref numbers)
      const HEADER_ORANGE_ALL = "FF7B3F00";
      const ROW_WG_DETAIL_ALT_ALL = "FFFFF8F0";
      const TOTAL_BG_ALL = "FFE8F0FE";

      const garbageBalesAll = bales.filter((b) => {
        const pid = b.productId ?? 0;
        const cat = productCategoryNameMap.get(pid) || b.category || "";
        return isWiperOrGarbage(cat);
      });

      const garbageDetailSheetAll = workbook.addWorksheet("Garbage & Wiper Details");
      const garbageBaleColsAll: Array<{ header: string; key: string; width: number }> = [
        { header: "Location", key: "locationName", width: 22 },
        { header: "Bale Ref #", key: "referenceNumber", width: 24 },
        { header: "Bale Code", key: "baleCode", width: 18 },
        { header: "Article Code", key: "articleCode", width: 18 },
        { header: "Product Name", key: "productName", width: 38 },
        { header: "Category", key: "category", width: 22 },
        { header: "Grade", key: "grade", width: 12 },
        { header: "Weight (kg)", key: "weightKg", width: 14 },
      ];
      if (includeCost) {
        garbageBaleColsAll.push({ header: "Cost/kg", key: "costPerKg", width: 14 });
        garbageBaleColsAll.push({ header: "Total Cost", key: "totalCost", width: 14 });
      }
      garbageDetailSheetAll.columns = garbageBaleColsAll;
      styleHeaderRow(garbageDetailSheetAll.getRow(1), HEADER_ORANGE_ALL);

      let gbTotalKgAll = 0;
      garbageBalesAll.forEach((b, idx) => {
        const locId = b.erpLocationId ?? 0;
        const pid = b.productId ?? 0;
        const w = parseFloat(String(b.weightKg || "0"));
        gbTotalKgAll += w;
        const rd: Record<string, string | number> = {
          locationName: locationMap.get(locId) || `Location #${locId}`,
          referenceNumber: b.referenceNumber,
          baleCode: b.baleCode || "",
          articleCode: b.articleCode || "",
          productName: b.productName || "",
          category: productCategoryNameMap.get(pid) || b.category || "",
          grade: b.grade || "",
          weightKg: w,
        };
        if (includeCost) {
          rd.costPerKg = parseFloat(String(b.costPerKg || "0"));
          rd.totalCost = parseFloat(String(b.totalCost || "0"));
        }
        const exRow = garbageDetailSheetAll.addRow(rd);
        applyDataRow(exRow, idx % 2 === 1, ROW_WG_DETAIL_ALT_ALL);
        exRow.getCell("weightKg").numFmt = NUM_FMT;
        if (includeCost) {
          exRow.getCell("costPerKg").numFmt = NUM_FMT;
          exRow.getCell("totalCost").numFmt = NUM_FMT;
        }
      });

      if (garbageBalesAll.length > 0) {
        garbageDetailSheetAll.addRow({});
        const gtd: Record<string, string | number> = {
          locationName: "GRAND TOTAL",
          referenceNumber: "",
          baleCode: "",
          articleCode: "",
          productName: `${garbageBalesAll.length} garbage/wiper bales`,
          category: "",
          grade: "",
          weightKg: parseFloat(gbTotalKgAll.toFixed(2)),
        };
        if (includeCost) {
          gtd.costPerKg = "";
          gtd.totalCost = parseFloat(
            garbageBalesAll.reduce((s, b) => s + parseFloat(String(b.totalCost || "0")), 0).toFixed(2)
          );
        }
        const gtr = garbageDetailSheetAll.addRow(gtd);
        gtr.font = { bold: true };
        gtr.eachCell({ includeEmpty: false }, (cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG_ALL } };
        });
        gtr.getCell("weightKg").numFmt = NUM_FMT;
        if (includeCost) gtr.getCell("totalCost").numFmt = NUM_FMT;
      }

      garbageDetailSheetAll.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: garbageBaleColsAll.length },
      };
      garbageDetailSheetAll.views = [{ state: "frozen", ySplit: 1 }];

      const dateStr = getClientDate(req);
      // Build buffer BEFORE setting headers so ExcelJS errors can still return a clean JSON 500.
      const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="inventory_all_locations_${dateStr}.xlsx"`);
      res.setHeader("Content-Length", xlsBuffer.byteLength);
      res.end(xlsBuffer);
    } catch (error: unknown) {
      logger.error("Error exporting all-locations inventory Excel:", { error: error });
      if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
