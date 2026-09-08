/**
 * factoryBalesRoutes: BalesReimport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { logAudit } from "../../helpers/auditHelpers";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { toArrayBuffer } from "../../../lib/bufferCompatibility";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";

import { adjustInventory } from "../../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { writeDaybookEntry } from "../_helpers";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryBales,
  stockItems,
  stockGroups,
  locations,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerBalesReimportRoutes(app: Express) {
  app.post(
    "/api/factory/bales/reimport",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      const multer = (await import("multer")).default;
      const upload = multer({ storage: multer.memoryStorage() });
      upload.single("file")(req, res, async (err: string) => {
        if (err) return res.status(400).json({ message: "File upload error" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        try {
          const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
          if (!companyId) return res.status(400).json({ message: "No company selected" });

          const ExcelJS = (await import("exceljs")).default;
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(toArrayBuffer(req.file.buffer));
          const sheet = workbook.getWorksheet(1);
          if (!sheet) return res.status(400).json({ message: "No worksheet found in file" });

          const headers: string[] = [];
          sheet.getRow(1).eachCell((cell, colNumber) => {
            headers[colNumber] = String(cell.value || "")
              .trim()
              .toLowerCase();
          });

          const refIdx = headers.findIndex((h) => h.includes("reference"));
          const articleIdx = headers.findIndex((h) => h.includes("article"));
          const nameIdx = headers.findIndex((h) => h.includes("product name"));
          const catIdx = headers.findIndex((h) => h.includes("category"));
          const weightIdx = headers.findIndex((h) => h.includes("weight"));
          const costPerKgIdx = headers.findIndex((h) => h.includes("cost per kg"));
          const totalCostIdx = headers.findIndex((h) => h.includes("total cost"));
          const locIdIdx = headers.findIndex((h) => h.includes("location id"));
          const statusIdx = headers.findIndex((h) => h.includes("status"));
          const mixBatchIdx = headers.findIndex((h) => h.includes("mix batch"));
          const baleCodeIdx = headers.findIndex((h) => h.includes("bale code"));
          const gradeIdx = headers.findIndex((h) => h.includes("grade"));
          const finalizedIdx = headers.findIndex((h) => h.includes("finalized"));

          if (refIdx < 0 || nameIdx < 0 || weightIdx < 0) {
            return res
              .status(400)
              .json({ message: "Excel must have at least: Reference Number, Product Name, Weight (kg) columns" });
          }

          const rows: any[] = [];
          const fileRefSet = new Set<string>();
          const fileDuplicates: string[] = [];

          sheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;
            const refNum = String(row.getCell(refIdx + 1).value || "").trim();
            if (!refNum) return;

            if (fileRefSet.has(refNum)) {
              fileDuplicates.push(refNum);
            }
            fileRefSet.add(refNum);

            rows.push({
              referenceNumber: refNum,
              articleCode: articleIdx >= 0 ? String(row.getCell(articleIdx + 1).value || "").trim() : "",
              productName: nameIdx >= 0 ? String(row.getCell(nameIdx + 1).value || "").trim() : "",
              category: catIdx >= 0 ? String(row.getCell(catIdx + 1).value || "").trim() : "",
              weightKg:
                weightIdx >= 0 ? String(parseFloat(String(row.getCell(weightIdx + 1).value || "0")) || "0") : "0",
              costPerKg:
                costPerKgIdx >= 0 ? String(parseFloat(String(row.getCell(costPerKgIdx + 1).value || "0")) || "0") : "0",
              totalCost:
                totalCostIdx >= 0 ? String(parseFloat(String(row.getCell(totalCostIdx + 1).value || "0")) || "0") : "0",
              erpLocationId: locIdIdx >= 0 ? parseInt(String(row.getCell(locIdIdx + 1).value || "0")) || null : null,
              status: statusIdx >= 0 ? String(row.getCell(statusIdx + 1).value || "IN_STOCK").trim() : "IN_STOCK",
              mixBatchId: mixBatchIdx >= 0 ? parseInt(String(row.getCell(mixBatchIdx + 1).value || "0")) || null : null,
              baleCode: baleCodeIdx >= 0 ? String(row.getCell(baleCodeIdx + 1).value || "").trim() : "",
              grade: gradeIdx >= 0 ? String(row.getCell(gradeIdx + 1).value || "").trim() : "",
              finalizedAt: finalizedIdx >= 0 ? String(row.getCell(finalizedIdx + 1).value || "").trim() : "",
            });
          });

          if (rows.length === 0) {
            return res.status(400).json({ message: "No bale rows found in Excel" });
          }

          if (fileDuplicates.length > 0) {
            return res.status(400).json({
              message: `Duplicate reference numbers within the file: ${fileDuplicates.slice(0, 10).join(", ")}`,
            });
          }

          const result = await db.transaction(async (tx) => {
            const existingBarcodes = await tx
              .select({ referenceNumber: factoryBales.referenceNumber })
              .from(factoryBales)
              .where(eq(factoryBales.companyId, companyId));
            const existingRefSet = new Set(existingBarcodes.map((b) => b.referenceNumber));

            const duplicates = rows.filter((r) => existingRefSet.has(r.referenceNumber));
            if (duplicates.length > 0) {
              throw new Error(
                `These reference numbers already exist: ${duplicates
                  .slice(0, 10)
                  .map((d) => d.referenceNumber)
                  .join(", ")}${duplicates.length > 10 ? ` and ${duplicates.length - 10} more` : ""}`
              );
            }

            const validLocIds = new Set<number>();
            const allLocs = await tx
              .select({ id: locations.id })
              .from(locations)
              .where(eq(locations.companyId, companyId));
            allLocs.forEach((l) => validLocIds.add(l.id));

            const invalidLocRows = rows.filter((r) => r.erpLocationId && !validLocIds.has(r.erpLocationId));
            if (invalidLocRows.length > 0) {
              throw new Error(
                `Invalid location IDs found: ${invalidLocRows
                  .map((r) => `${r.referenceNumber} (loc ${r.erpLocationId})`)
                  .slice(0, 5)
                  .join(", ")}`
              );
            }

            const allProducts = await tx
              .select()
              .from(factoryBaleProducts)
              .where(eq(factoryBaleProducts.companyId, companyId));
            type ImportedBaleProduct = (typeof allProducts)[number];
            const productByName = new Map<string, ImportedBaleProduct>(
              allProducts.map((p: ImportedBaleProduct) => [p.name.toLowerCase(), p] as const)
            );
            const productByArticle = new Map<string | undefined, ImportedBaleProduct>(
              allProducts.map((p: ImportedBaleProduct) => [p.articleCode?.toLowerCase(), p] as const)
            );

            const allCategories = await tx
              .select()
              .from(factoryCategories)
              .where(eq(factoryCategories.companyId, companyId));
            type ImportedBaleCategory = (typeof allCategories)[number];
            const categoryByName = new Map<string | undefined, ImportedBaleCategory>(
              allCategories.map((c: ImportedBaleCategory) => [c.name?.toLowerCase(), c] as const)
            );

            const createdBales: any[] = [];
            let totalWeight = 0;

            for (const row of rows) {
              let product =
                (row.articleCode ? productByArticle.get(row.articleCode.toLowerCase()) : null) ||
                productByName.get(row.productName.toLowerCase());
              if (!product) {
                const autoCode =
                  row.articleCode ||
                  "IMP-" +
                    row.productName
                      .replace(/[^a-zA-Z0-9]/g, "")
                      .toUpperCase()
                      .substring(0, 20) +
                    "-" +
                    Date.now().toString(36).slice(-4).toUpperCase();
                const categoryObj = row.category ? categoryByName.get(row.category.toLowerCase()) : null;
                const [newProduct] = await tx
                  .insert(factoryBaleProducts)
                  .values({
                    companyId,
                    code: autoCode,
                    articleCode: row.articleCode || autoCode,
                    name: row.productName,
                    active: true,
                    ...(categoryObj ? { categoryId: categoryObj.id } : {}),
                  })
                  .returning();
                product = newProduct;
                productByName.set(row.productName.toLowerCase(), product);
                if (row.articleCode) productByArticle.set(row.articleCode.toLowerCase(), product);
              }

              let finalizedAt: Date | null = null;
              if (row.finalizedAt) {
                const parsed = new Date(row.finalizedAt);
                if (!isNaN(parsed.getTime())) finalizedAt = parsed;
              }
              if (!finalizedAt) finalizedAt = new Date();

              const originalStatus = row.status || "IN_STOCK";

              const [bale] = await tx
                .insert(factoryBales)
                .values({
                  companyId,
                  productId: product.id,
                  erpLocationId: row.erpLocationId,
                  baleCode: row.baleCode || product.code,
                  referenceNumber: row.referenceNumber,
                  articleCode: row.articleCode || product.articleCode,
                  productName: row.productName,
                  category: row.category || null,
                  grade: row.grade || null,
                  weightKg: row.weightKg,
                  costPerKg: row.costPerKg,
                  totalCost: row.totalCost,
                  status: originalStatus,
                  mixBatchId: row.mixBatchId,
                  finalizedAt,
                })
                .returning();

              createdBales.push({ ...bale, _product: product });
              totalWeight += parseFloat(row.weightKg);
            }

            const stockGroupCache = new Map<string, number>();
            const stockItemCache = new Map<string, number>();

            for (const bale of createdBales) {
              if (bale.status === "REMOVED" || bale.status === "DELETED") continue;

              const itemCode: string = bale.articleCode || bale.baleCode;
              if (!itemCode) continue;
              const locId = bale.erpLocationId;
              if (!locId) continue;

              const product = bale._product;
              let stockGroupId: number | null = null;
              if (bale.category) {
                const catName = bale.category as string;
                const catId = product?.categoryId as number | undefined;
                const cacheKey = catId ? String(catId) : catName;
                const cached = stockGroupCache.get(cacheKey);
                if (cached) {
                  stockGroupId = cached;
                } else {
                  const [existingGroup] = await tx
                    .select({ id: stockGroups.id })
                    .from(stockGroups)
                    .where(and(eq(stockGroups.companyId, companyId), eq(stockGroups.name, catName)));
                  if (existingGroup) {
                    stockGroupId = existingGroup.id;
                  } else {
                    // Use the category's own ID for a collision-free code
                    const groupCode = catId
                      ? `FCAT-${catId}`
                      : "F-" +
                        catName
                          .replace(/[^A-Z0-9]/gi, "")
                          .substring(0, 10)
                          .toUpperCase();
                    const [created] = await tx
                      .insert(stockGroups)
                      .values({ companyId, name: catName, code: groupCode })
                      .onConflictDoNothing()
                      .returning({ id: stockGroups.id });
                    if (created) {
                      stockGroupId = created.id;
                    } else {
                      const [byCode] = await tx
                        .select({ id: stockGroups.id })
                        .from(stockGroups)
                        .where(and(eq(stockGroups.companyId, companyId), eq(stockGroups.code, groupCode)));
                      stockGroupId = byCode?.id;
                    }
                  }
                  stockGroupCache.set(cacheKey, stockGroupId!);
                }
              }

              let erpStockItemId = stockItemCache.get(itemCode);
              if (!erpStockItemId) {
                const [existing] = await tx
                  .select({ id: stockItems.id, stockGroupId: stockItems.stockGroupId })
                  .from(stockItems)
                  .where(and(eq(stockItems.companyId, companyId), eq(stockItems.code, itemCode)));

                if (existing) {
                  erpStockItemId = existing.id;
                  if (stockGroupId && !existing.stockGroupId) {
                    await tx.update(stockItems).set({ stockGroupId }).where(eq(stockItems.id, existing.id));
                  }
                } else {
                  const [created] = await tx
                    .insert(stockItems)
                    .values({
                      companyId,
                      code: itemCode,
                      name: bale.productName as string,
                      uom: "BALE",
                      active: true,
                      ...(stockGroupId ? { stockGroupId } : {}),
                    })
                    .returning({ id: stockItems.id });
                  erpStockItemId = created.id;
                }
                stockItemCache.set(itemCode, erpStockItemId!);
              }

              const costPerKg = parseFloat(bale.costPerKg || "0");
              const weight = parseFloat(bale.weightKg || "0");
              const baleCost = weight * costPerKg;
              await adjustInventory(tx, locId, erpStockItemId!, 1, companyId, baleCost);
              await postStockMovementTx(
                tx,
                {
                  companyId,
                  stockItemId: erpStockItemId!,
                  kind: "receipt",
                  quantity: "1",
                  unitCost: String(Math.max(baleCost, 0)),
                  toLocationId: locId,
                  occurredAt: (bale.finalizedAt instanceof Date ? bale.finalizedAt : new Date()).toISOString(),
                  source: {
                    sourceType: "factory_bale_reimport",
                    sourceId: String(bale.id),
                    idempotencyKey: `factory-bale-reimport:${companyId}:${bale.id}`,
                  },
                  actor: {
                    userId: req.session.userId,
                    username: req.session.username,
                    reason: `Bale reimport ${bale.referenceNumber}`,
                  },
                  allowNegativeStock: true,
                },
                canonicalStockMovementAdapter
              );
            }

            return { count: createdBales.length, totalWeight };
          });

          const today = req.body.txDate || getClientDate(req);
          await writeDaybookEntry(db, {
            companyId,
            txDate: today,
            txType: "BALE_REIMPORT",
            description: `Reimported ${result.count} bale(s) with original reference numbers (${result.totalWeight.toFixed(1)} kg)`,
          });

          res.json({ imported: result.count, totalWeight: result.totalWeight });
        } catch (error: unknown) {
          logger.error("Error reimporting bales:", { error: error });
          res.status(400).json({ message: getErrorMessage(error) });
        }
      });
    }
  );

  // GET /api/factory/bales/export-names.xlsx — Export all bales for bulk product-name editing
  app.get(
    "/api/factory/bales/export-names.xlsx",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const bales = await db
          .select()
          .from(factoryBales)
          .where(eq(factoryBales.companyId, companyId))
          .orderBy(factoryBales.id);

        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("Bales");

        sheet.columns = [
          { header: "ID (do not edit)", key: "id", width: 18 },
          { header: "Bale Code", key: "baleCode", width: 18 },
          { header: "Reference Number", key: "referenceNumber", width: 22 },
          { header: "Category", key: "category", width: 16 },
          { header: "Grade", key: "grade", width: 12 },
          { header: "Product Name", key: "productName", width: 30 },
        ];

        const headerRow = sheet.getRow(1);
        headerRow.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF374151" } };
        });
        const idHeaderCell = sheet.getCell("A1");
        idHeaderCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6B7280" } };

        for (const bale of bales) {
          const row = sheet.addRow({
            id: bale.id,
            baleCode: bale.baleCode,
            referenceNumber: bale.referenceNumber,
            category: bale.category ?? "",
            grade: bale.grade ?? "",
            productName: bale.productName ?? "",
          });
          const idCell = row.getCell("id");
          idCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
          idCell.font = { color: { argb: "FF6B7280" } };
        }

        sheet.protect("", { selectLockedCells: true, selectUnlockedCells: true });

        const xlsBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="bale_names_${companyId}.xlsx"`);
        res.setHeader("Content-Length", xlsBuffer.byteLength);
        res.end(xlsBuffer);
      } catch (error: unknown) {
        logger.error("Error exporting bale names:", { error: error });
        if (!res.headersSent) res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // POST /api/factory/bales/bulk-update-names — Upload Excel and update product_name in bulk
  app.post(
    "/api/factory/bales/bulk-update-names",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      const multer = (await import("multer")).default;
      const upload = multer({ storage: multer.memoryStorage() });
      upload.single("file")(req, res, async (err: string) => {
        if (err) return res.status(400).json({ message: "File upload error" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        try {
          const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
          if (!companyId) return res.status(400).json({ message: "No company selected" });

          const { read: readXlsx, utils } = await import("xlsx-js-style");
          const wb = readXlsx(req.file.buffer, { type: "buffer" });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const rows: any[] = utils.sheet_to_json(sheet, { defval: "" });

          let updated = 0;
          let skipped = 0;
          const errors: string[] = [];

          for (const row of rows) {
            const id = parseInt(row["ID (do not edit)"] ?? row["id"] ?? row["ID"]);
            const productName = String(row["Product Name"] ?? row["productName"] ?? "").trim();

            if (!id || isNaN(id)) {
              skipped++;
              continue;
            }
            if (!productName) {
              skipped++;
              continue;
            }

            const [bale] = await db
              .select()
              .from(factoryBales)
              .where(and(eq(factoryBales.id, id), eq(factoryBales.companyId, companyId)));

            if (!bale) {
              errors.push(`Bale ID ${id} not found`);
              skipped++;
              continue;
            }

            if (bale.productId) {
              await db
                .update(factoryBaleProducts)
                .set({ name: productName, updatedAt: new Date() })
                .where(and(eq(factoryBaleProducts.id, bale.productId), eq(factoryBaleProducts.companyId, companyId)));
            }

            await db.update(factoryBales).set({ productName, updatedAt: new Date() }).where(eq(factoryBales.id, id));

            updated++;
          }

          try {
            await logAudit({
              userId: req.session.userId!,
              username: req.session.username || req.session.userId!,
              companyId,
              action: "update",
              tableName: "factory_bales",
              recordId: null,
              recordIdentifier: `bulk-rename: ${updated} bale(s) updated, ${skipped} skipped`,
              changes: null,
            });
          } catch (auditErr) {
            logger.error("[bulk-update-names audit] non-fatal:", { error: auditErr });
          }

          res.json({ updated, skipped, errors });
        } catch (error: unknown) {
          logger.error("Error bulk-updating bale names:", { error: error });
          res.status(500).json({ message: getErrorMessage(error) });
        }
      });
    }
  );
}
