/**
 * factoryStockRoutes: FactoryLocationInventory endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import ExcelJS from "exceljs";
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
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
  factorySettings,
} from "@shared/schema";
import { eq, and, or, sql, inArray } from "drizzle-orm";

export function registerFactoryLocationInventoryRoutes(app: Express) {
  app.get("/api/factory/location-inventory/:locationId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const locationId = parseId(req.params.locationId);

      if (locationId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

      const bales = await db
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.erpLocationId, locationId),
            eq(factoryBales.status, "IN_STOCK"),
            // Exclude bales already assigned to active or completed outbound orders,
            // even when their stored DB status is still IN_STOCK.
            sql`NOT EXISTS (
              SELECT 1 FROM customer_order_bales cob
              INNER JOIN customer_orders co ON co.id = cob.order_id
              WHERE cob.bale_id = ${factoryBales.id}
                AND co.status IN ('LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED','DISPATCHED','SOLD')
                AND co.company_id = ${companyId}
            )`
          )
        );

      // Find which of these IN_STOCK bales are currently in an active order
      // (LOADING, PENDING_VERIFICATION, or VERIFIED). This matches the Bale Ledger's
      // "Pending Loading / Verified" definition so the two pages stay in sync.
      const baleIds = bales.map((b) => b.id);
      const loadingBaleIds = new Set<number>();
      if (baleIds.length > 0) {
        const loadingRows = await db
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
              inArray(customerOrderBales.baleId, baleIds)
            )
          );
        for (const r of loadingRows) loadingBaleIds.add(r.baleId);
      }

      // Fetch ALL products for the company so we can also match by articleCode
      // (bales imported historically may have productId=null but articleCode set)
      const allProducts = await db
        .select()
        .from(factoryBaleProducts)
        .where(eq(factoryBaleProducts.companyId, companyId));

      const categoryIds = [...new Set(allProducts.map((p) => p.categoryId).filter((id): id is number => id != null))];
      const categories =
        categoryIds.length > 0
          ? await db
              .select()
              .from(factoryCategories)
              .where(and(eq(factoryCategories.companyId, companyId), inArray(factoryCategories.id, categoryIds)))
          : [];

      const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
      // Primary lookup: by product id
      const productById = new Map(allProducts.map((p) => [p.id, p]));
      // Fallback lookup: by articleCode (for bales where productId is null/0)
      const productByArticleCode = new Map(
        allProducts.filter((p) => p.articleCode).map((p) => [p.articleCode!.toLowerCase(), p])
      );

      const getProduct = (bale: (typeof bales)[number]) => {
        const byId = bale.productId ? productById.get(bale.productId) : undefined;
        if (byId) return byId;
        return bale.articleCode ? productByArticleCode.get(bale.articleCode.toLowerCase()) : undefined;
      };

      const grouped = new Map<
        string,
        {
          productId: number;
          articleCode: string;
          productName: string;
          productNameAr: string | null;
          category: string | null;
          categoryId: number | null;
          quantity: number;
          totalWeight: number;
          totalCost: number;
          baleCount: number;
          loadingCount: number;
          sellingPrice: string;
          productionPrice: number;
          referenceNumbers: string[];
        }
      >();

      for (const b of bales) {
        const product = getProduct(b);
        const groupKey = product ? `p:${product.id}` : `a:${b.articleCode || b.baleCode || "unknown"}`;
        const existing = grouped.get(groupKey);
        const qty = parseFloat(String(b.quantity || "1"));
        const weight = parseFloat(String(b.weightKg || "0"));
        const productionPrice = parseFloat(String(product?.productionPrice || "0"));
        const sellingPrice = String(product?.sellingPrice || "0");
        const categoryName = product?.categoryId
          ? categoryMap.get(product.categoryId) || b.category || null
          : b.category || null;
        const categoryId = product?.categoryId || null;
        const refNum: string = b.referenceNumber || "";
        const isLoading = loadingBaleIds.has(b.id);
        if (existing) {
          existing.quantity += qty;
          existing.totalWeight += weight;
          existing.totalCost += productionPrice;
          existing.baleCount += 1;
          if (isLoading) existing.loadingCount += 1;
          if (refNum) existing.referenceNumbers.push(refNum);
        } else {
          grouped.set(groupKey, {
            productId: product?.id || b.productId || 0,
            articleCode: product?.articleCode || b.articleCode || b.baleCode || "",
            productName: product?.name || b.productName || "Unknown",
            productNameAr: product?.nameAr || null,
            category: categoryName,
            categoryId,
            quantity: qty,
            totalWeight: weight,
            totalCost: productionPrice,
            baleCount: 1,
            loadingCount: isLoading ? 1 : 0,
            sellingPrice,
            productionPrice,
            referenceNumbers: refNum ? [refNum] : [],
          });
        }
      }

      const result = Array.from(grouped.values()).sort((a, b) => a.productName.localeCompare(b.productName));
      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching factory location inventory:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Returns inventory with pending proforma reservations subtracted
  app.get("/api/factory/location-inventory/:locationId/available", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const locationId = parseId(req.params.locationId);

      if (locationId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

      // --- stock (same logic as base endpoint) ---
      const bales = await db
        .select()
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.erpLocationId, locationId),
            eq(factoryBales.status, "IN_STOCK"),
            // Exclude bales already assigned to active or completed outbound orders
            sql`NOT EXISTS (
              SELECT 1 FROM customer_order_bales cob
              INNER JOIN customer_orders co ON co.id = cob.order_id
              WHERE cob.bale_id = ${factoryBales.id}
                AND co.status IN ('LOADING','PENDING_VERIFICATION','VERIFIED','FINALIZED','DISPATCHED','SOLD')
                AND co.company_id = ${companyId}
            )`
          )
        );

      const allProducts = await db
        .select()
        .from(factoryBaleProducts)
        .where(eq(factoryBaleProducts.companyId, companyId));
      const categoryIds = [...new Set(allProducts.map((p) => p.categoryId).filter((id): id is number => id != null))];
      const categories =
        categoryIds.length > 0
          ? await db
              .select()
              .from(factoryCategories)
              .where(and(eq(factoryCategories.companyId, companyId), inArray(factoryCategories.id, categoryIds)))
          : [];
      const categoryMap = new Map(categories.map((c) => [c.id, c.name]));
      const productById = new Map(allProducts.map((p) => [p.id, p]));
      const productByArticleCode = new Map(
        allProducts.filter((p) => p.articleCode).map((p) => [p.articleCode!.toLowerCase(), p])
      );
      const getProduct = (bale: (typeof bales)[number]) => {
        const byId = bale.productId ? productById.get(bale.productId) : undefined;
        if (byId) return byId;
        return bale.articleCode ? productByArticleCode.get(bale.articleCode.toLowerCase()) : undefined;
      };

      const grouped = new Map<
        string,
        {
          productId: number;
          articleCode: string;
          productName: string;
          productNameAr: string | null;
          category: string | null;
          categoryId: number | null;
          quantity: number;
          totalWeight: number;
          totalCost: number;
          baleCount: number;
          sellingPrice: string;
          productionPrice: number;
        }
      >();

      for (const b of bales) {
        const product = getProduct(b);
        const groupKey = product ? `p:${product.id}` : `a:${b.articleCode || b.baleCode || "unknown"}`;
        const existing = grouped.get(groupKey);
        const qty = parseFloat(String(b.quantity || "1"));
        const weight = parseFloat(String(b.weightKg || "0"));
        const productionPrice = parseFloat(String(product?.productionPrice || "0"));
        const sellingPrice = String(product?.sellingPrice || "0");
        const categoryName = product?.categoryId
          ? categoryMap.get(product.categoryId) || b.category || null
          : b.category || null;
        const categoryId = product?.categoryId || null;
        if (existing) {
          existing.quantity += qty;
          existing.totalWeight += weight;
          existing.totalCost += productionPrice;
          existing.baleCount += 1;
        } else {
          grouped.set(groupKey, {
            productId: product?.id || b.productId || 0,
            articleCode: product?.articleCode || b.articleCode || b.baleCode || "",
            productName: product?.name || b.productName || "Unknown",
            productNameAr: product?.nameAr || null,
            category: categoryName,
            categoryId,
            quantity: qty,
            totalWeight: weight,
            totalCost: productionPrice,
            baleCount: 1,
            sellingPrice,
            productionPrice,
          });
        }
      }

      // Return stock as-is — no reservation subtraction
      const result = Array.from(grouped.values())
        .map((item) => {
          return { ...item, reservedQty: 0, availableQty: item.baleCount, reservations: [] };
        })
        .sort((a, b) => a.productName.localeCompare(b.productName));

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching available factory location inventory:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get(
    "/api/factory/location-inventory/:locationId/export/excel",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const locationId = parseId(req.params.locationId);

        if (locationId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

        const [fCfg] = await db
          .select({ hideAvgCost: factorySettings.hideAvgCost, hideSellingPrice: factorySettings.hideSellingPrice })
          .from(factorySettings)
          .where(eq(factorySettings.companyId, companyId))
          .limit(1);
        const userVis = await getExportPriceVisibility(req);
        const includeCost = req.query.includeCost !== "0" && !fCfg?.hideAvgCost && !userVis.hideCost;
        const includeSellPrice = req.query.includeSellPrice !== "0" && !fCfg?.hideSellingPrice && !userVis.hideSelling;

        // Only IN_STOCK — exclude FINALIZED and RESERVED
        const allLocationBales = await db
          .select()
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              eq(factoryBales.erpLocationId, locationId),
              eq(factoryBales.status, "IN_STOCK")
            )
          );

        // Exclude bales in active orders: LOADING, PENDING_VERIFICATION, or VERIFIED
        const allLocationBaleIds = allLocationBales.map((b) => b.id);
        const loadingBaleIdsExport = new Set<number>();
        if (allLocationBaleIds.length > 0) {
          const loadingRows = await db
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
                inArray(customerOrderBales.baleId, allLocationBaleIds)
              )
            );
          for (const r of loadingRows) loadingBaleIdsExport.add(r.baleId);
        }
        const bales = allLocationBales.filter((b) => !loadingBaleIdsExport.has(b.id));

        const productIds = [
          ...new Set(bales.map((b) => b.productId).filter((id): id is number => id != null && id > 0)),
        ];
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
        const productSellingPriceMap = new Map(products.map((p) => [p.id, parseFloat(p.sellingPrice || "0")]));

        const isWiperOrGarbage = (catName: string) => {
          const n = catName.toLowerCase();
          return n.includes("wiper") || n.includes("garbage") || n.includes("rag");
        };

        type GroupedRow = {
          articleCode: string;
          productName: string;
          category: string;
          baleCount: number;
          totalWeight: number;
          productionPrice: number;
          sellingPrice: number;
        };
        const mainGrouped = new Map<number, GroupedRow>();
        const wgGrouped = new Map<number, GroupedRow>();

        for (const b of bales) {
          const pid = b.productId || 0;
          const weight = parseFloat(String(b.weightKg || "0"));
          const catName = productCategoryNameMap.get(pid) || b.category || "";
          const target = isWiperOrGarbage(catName) ? wgGrouped : mainGrouped;
          const existing = target.get(pid);
          if (existing) {
            existing.totalWeight += weight;
            existing.baleCount += 1;
          } else {
            target.set(pid, {
              articleCode: b.articleCode || b.baleCode || "",
              productName: b.productName || "Unknown",
              category: catName,
              totalWeight: weight,
              baleCount: 1,
              productionPrice: productProductionPriceMap.get(pid) || 0,
              sellingPrice: productSellingPriceMap.get(pid) || 0,
            });
          }
        }

        const mainRows = Array.from(mainGrouped.values()).sort((a, b) => a.productName.localeCompare(b.productName));
        const wgRows = Array.from(wgGrouped.values()).sort((a, b) => a.productName.localeCompare(b.productName));
        const sortedBales = [...bales].sort((a, b) => (a.productName || "").localeCompare(b.productName || ""));

        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        workbook.creator = "Factory System";
        workbook.created = new Date();

        const HEADER_BLUE = "FF1F4E79"; // dark navy
        const HEADER_PURPLE = "FF4B2D7F"; // dark purple for wiper/garbage sheet
        const HEADER_TEAL = "FF1D5F6A"; // dark teal for bale detail
        const ROW_ALT = "FFF5F8FF"; // very light blue alternating
        const ROW_WG_ALT = "FFFAF5FF"; // very light purple alternating
        const TOTAL_BG = "FFE8F0FE";
        const NUM_FMT = "#,##0.00";
        const INT_FMT = "#,##0";

        const styleHeaderRow = (row: ExcelJS.Row, argbColor: string) => {
          row.height = 20;
          row.eachCell((cell: ExcelJS.Cell) => {
            cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argbColor } };
            cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
            cell.border = {
              bottom: { style: "medium", color: { argb: "FFD0D0D0" } },
            };
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

        const buildSummarySheet = (
          ws: ExcelJS.Worksheet,
          rows: GroupedRow[],
          label: string,
          headerColor: string,
          altColor: string
        ) => {
          const cols: Array<{ header: string; key: string; width: number }> = [
            { header: "Article Code", key: "articleCode", width: 18 },
            { header: "Product Name", key: "productName", width: 38 },
            { header: "Category", key: "category", width: 22 },
            { header: "Bales", key: "baleCount", width: 10 },
            { header: "Wt/Bale (kg)", key: "weightPerBale", width: 14 },
            { header: "Total KG", key: "totalWeight", width: 14 },
          ];
          if (includeCost) {
            cols.push({ header: "Rate (Cost)", key: "productionPrice", width: 14 });
            cols.push({ header: "Total Cost", key: "totalCostValue", width: 16 });
          }
          if (includeSellPrice) {
            cols.push({ header: "Sell Price", key: "sellingPrice", width: 14 });
            cols.push({ header: "Total Sell Value", key: "totalSellValue", width: 16 });
          }
          ws.columns = cols;
          styleHeaderRow(ws.getRow(1), headerColor);

          let totalBales = 0,
            totalKg = 0,
            totalCost = 0,
            totalSell = 0;
          rows.forEach((row, idx) => {
            const wpb = row.baleCount > 0 ? row.totalWeight / row.baleCount : 0;
            const tc = row.productionPrice * row.baleCount;
            const ts = row.sellingPrice * row.baleCount;
            totalBales += row.baleCount;
            totalKg += row.totalWeight;
            totalCost += tc;
            totalSell += ts;

            const rd: Record<string, string | number> = {
              articleCode: row.articleCode,
              productName: row.productName,
              category: row.category,
              baleCount: row.baleCount,
              weightPerBale: parseFloat(wpb.toFixed(2)),
              totalWeight: parseFloat(row.totalWeight.toFixed(2)),
            };
            if (includeCost) {
              rd.productionPrice = row.productionPrice;
              rd.totalCostValue = parseFloat(tc.toFixed(2));
            }
            if (includeSellPrice) {
              rd.sellingPrice = row.sellingPrice;
              rd.totalSellValue = parseFloat(ts.toFixed(2));
            }
            const exRow = ws.addRow(rd);
            applyDataRow(exRow, idx % 2 === 1, altColor);
            // Number formats
            exRow.getCell("baleCount").numFmt = INT_FMT;
            exRow.getCell("weightPerBale").numFmt = NUM_FMT;
            exRow.getCell("totalWeight").numFmt = NUM_FMT;
            if (includeCost) {
              exRow.getCell("productionPrice").numFmt = NUM_FMT;
              exRow.getCell("totalCostValue").numFmt = NUM_FMT;
            }
            if (includeSellPrice) {
              exRow.getCell("sellingPrice").numFmt = NUM_FMT;
              exRow.getCell("totalSellValue").numFmt = NUM_FMT;
            }
          });

          ws.addRow({});
          const td: Record<string, string | number> = {
            articleCode: "",
            productName: `TOTAL — ${rows.length} ${label}`,
            category: "",
            baleCount: totalBales,
            weightPerBale: "",
            totalWeight: parseFloat(totalKg.toFixed(2)),
          };
          if (includeCost) {
            td.productionPrice = "";
            td.totalCostValue = parseFloat(totalCost.toFixed(2));
          }
          if (includeSellPrice) {
            td.sellingPrice = "";
            td.totalSellValue = parseFloat(totalSell.toFixed(2));
          }
          const tr = ws.addRow(td);
          tr.font = { bold: true };
          tr.eachCell({ includeEmpty: false }, (cell: ExcelJS.Cell) => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
          });
          tr.getCell("baleCount").numFmt = INT_FMT;
          tr.getCell("totalWeight").numFmt = NUM_FMT;
          if (includeCost) tr.getCell("totalCostValue").numFmt = NUM_FMT;
          if (includeSellPrice) tr.getCell("totalSellValue").numFmt = NUM_FMT;

          ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
          ws.views = [{ state: "frozen", ySplit: 1 }];
        };

        // Sheet 1: Stock Summary (main items only)
        const summarySheet = workbook.addWorksheet("Stock Summary");
        buildSummarySheet(summarySheet, mainRows, "products", HEADER_BLUE, ROW_ALT);

        // Sheet 2: Wipers & Garbage
        const wgSheet = workbook.addWorksheet("Wipers & Garbage");
        buildSummarySheet(wgSheet, wgRows, "items", HEADER_PURPLE, ROW_WG_ALT);

        // Sheet 3: Bale Details (main only — no wipers/garbage)
        const mainBales = sortedBales.filter((b) => {
          const pid = b.productId ?? 0;
          const cat = productCategoryNameMap.get(pid) || b.category || "";
          return !isWiperOrGarbage(cat);
        });

        const baleSheet = workbook.addWorksheet("Bale Details");
        const baleCols: Array<{ header: string; key: string; width: number }> = [
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

        mainBales.forEach((b, idx) => {
          const pid = b.productId ?? 0;
          const rd: Record<string, string | number> = {
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

        // Sheet 4: Garbage & Wiper Bale Details (with reference numbers)
        const HEADER_ORANGE = "FF7B3F00";
        const ROW_WG_DETAIL_ALT = "FFFFF8F0";

        const garbageBales = sortedBales.filter((b) => {
          const pid = b.productId ?? 0;
          const cat = productCategoryNameMap.get(pid) || b.category || "";
          return isWiperOrGarbage(cat);
        });

        const garbageDetailSheet = workbook.addWorksheet("Garbage & Wiper Details");
        const garbageBaleCols: Array<{ header: string; key: string; width: number }> = [
          { header: "Bale Ref #", key: "referenceNumber", width: 24 },
          { header: "Bale Code", key: "baleCode", width: 18 },
          { header: "Article Code", key: "articleCode", width: 18 },
          { header: "Product Name", key: "productName", width: 38 },
          { header: "Category", key: "category", width: 22 },
          { header: "Grade", key: "grade", width: 12 },
          { header: "Weight (kg)", key: "weightKg", width: 14 },
        ];
        if (includeCost) {
          garbageBaleCols.push({ header: "Cost/kg", key: "costPerKg", width: 14 });
          garbageBaleCols.push({ header: "Total Cost", key: "totalCost", width: 14 });
        }
        garbageDetailSheet.columns = garbageBaleCols;
        styleHeaderRow(garbageDetailSheet.getRow(1), HEADER_ORANGE);

        let gbTotalKg = 0;
        garbageBales.forEach((b, idx) => {
          const pid = b.productId ?? 0;
          const w = parseFloat(String(b.weightKg || "0"));
          gbTotalKg += w;
          const rd: Record<string, string | number> = {
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
          const exRow = garbageDetailSheet.addRow(rd);
          applyDataRow(exRow, idx % 2 === 1, ROW_WG_DETAIL_ALT);
          exRow.getCell("weightKg").numFmt = NUM_FMT;
          if (includeCost) {
            exRow.getCell("costPerKg").numFmt = NUM_FMT;
            exRow.getCell("totalCost").numFmt = NUM_FMT;
          }
        });

        // Totals row for garbage sheet
        if (garbageBales.length > 0) {
          garbageDetailSheet.addRow({});
          const gtd: Record<string, string | number> = {
            referenceNumber: "",
            baleCode: "",
            articleCode: "",
            productName: `TOTAL — ${garbageBales.length} bales`,
            category: "",
            grade: "",
            weightKg: parseFloat(gbTotalKg.toFixed(2)),
          };
          if (includeCost) {
            gtd.costPerKg = "";
            gtd.totalCost = parseFloat(
              garbageBales.reduce((s, b) => s + parseFloat(String(b.totalCost || "0")), 0).toFixed(2)
            );
          }
          const gtr = garbageDetailSheet.addRow(gtd);
          gtr.font = { bold: true };
          gtr.eachCell({ includeEmpty: false }, (cell) => {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
          });
          gtr.getCell("weightKg").numFmt = NUM_FMT;
          if (includeCost) gtr.getCell("totalCost").numFmt = NUM_FMT;
        }

        garbageDetailSheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: garbageBaleCols.length } };
        garbageDetailSheet.views = [{ state: "frozen", ySplit: 1 }];

        const dateStr = getClientDate(req);
        // Build buffer BEFORE setting headers so ExcelJS errors can still return a clean JSON 500.
        const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="inventory_location_${locationId}_${dateStr}.xlsx"`);
        res.setHeader("Content-Length", xlsBuffer.byteLength);
        res.end(xlsBuffer);
      } catch (error: unknown) {
        logger.error("Error exporting inventory Excel:", { error: error });
        if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
