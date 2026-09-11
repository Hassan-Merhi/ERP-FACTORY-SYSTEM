/**
 * factoryProductsRoutes: FactoryProductImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry } from "../_helpers";
import { factoryCategories, factoryBaleProducts, factoryBales, factoryBaleSequences } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerFactoryProductImportRoutes(app: Express) {
  app.post("/api/factory/bale-products/import-excel", requireAuth, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({ storage: multer.memoryStorage() });

      upload.single("file")(req, res, async (err) => {
        try {
          if (err) return res.status(400).json({ message: getErrorMessage(err) });

          const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
          if (!companyId) return res.status(400).json({ message: "No company selected" });

          if (!req.file) return res.status(400).json({ message: "No file uploaded" });

          const {
            read: readExcel,
            utils: { sheet_to_json: sheetToJson },
          } = await import("xlsx-js-style");
          const workbook = readExcel(req.file.buffer, { type: "buffer" });
          const sheetName = workbook.SheetNames[0];
          const rows = sheetToJson<Record<string, unknown>>(workbook.Sheets[sheetName]);

          let created = 0;
          let updated = 0;
          let categoriesCreated = 0;
          let pricesUpdated = 0;
          let skippedNoArticleCode = 0;

          // Detect column names from the first row for feedback
          const firstRow = rows[0] || {};
          const detectedArticleCodeCol =
            Object.keys(firstRow).find((k) =>
              ["articlecode", "article_code", "article code", "barcode"].includes(k.toLowerCase())
            ) || null;
          const detectedProductionPriceCol =
            Object.keys(firstRow).find((k) =>
              [
                "production price",
                "productionprice",
                "production_price",
                "cost price",
                "costprice",
                "cost_price",
              ].includes(k.toLowerCase())
            ) || null;
          const detectedSellingPriceCol =
            Object.keys(firstRow).find((k) =>
              ["selling price", "sellingprice", "selling_price"].includes(k.toLowerCase())
            ) || null;

          const categoryCache = new Map<string, number>();
          const existingCategories = await db
            .select()
            .from(factoryCategories)
            .where(eq(factoryCategories.companyId, companyId));
          for (const cat of existingCategories) {
            categoryCache.set(cat.name.toLowerCase(), cat.id);
          }

          for (const row of rows) {
            const articleCode = String(
              row.articleCode || row.article_code || row.ArticleCode || row["Article Code"] || ""
            ).trim();
            if (!articleCode) {
              skippedNoArticleCode++;
              continue;
            }

            const name = String(row.name || row.Name || row.productName || row["Product Name"] || articleCode).trim();
            const description = String(row.description || row.Description || "").trim() || null;
            const weightPerBaleKg =
              row.weightPerBaleKg ||
              row.weight_per_bale_kg ||
              row.WeightPerBaleKg ||
              row["Weight Per Bale"] ||
              row.weight ||
              null;
            const categoryName = String(row.category || row.Category || row.categoryName || "").trim();

            const rawSellingPrice =
              row["selling price"] ??
              row["sellingPrice"] ??
              row["selling_price"] ??
              row["Selling Price"] ??
              row["SELLING PRICE"] ??
              null;
            const sellingPrice =
              rawSellingPrice !== null && rawSellingPrice !== ""
                ? String(parseFloat(String(rawSellingPrice)) || 0)
                : null;

            const rawProductionPrice =
              row["production price"] ??
              row["productionPrice"] ??
              row["production_price"] ??
              row["Production Price"] ??
              row["PRODUCTION PRICE"] ??
              row["cost price"] ??
              row["costPrice"] ??
              row["cost_price"] ??
              row["Cost Price"] ??
              null;
            const productionPrice =
              rawProductionPrice !== null && rawProductionPrice !== ""
                ? String(parseFloat(String(rawProductionPrice)) || 0)
                : null;

            let categoryId: number | null = null;
            if (categoryName) {
              const cachedId = categoryCache.get(categoryName.toLowerCase());
              if (cachedId) {
                categoryId = cachedId;
              } else {
                const [newCat] = await db
                  .insert(factoryCategories)
                  .values({ companyId, name: categoryName })
                  .returning();
                categoryId = newCat.id;
                categoryCache.set(categoryName.toLowerCase(), newCat.id);
                categoriesCreated++;
              }
            }

            const code = articleCode
              .replace(/[^a-zA-Z0-9]/g, "")
              .toUpperCase()
              .substring(0, 50);

            let [existing] = await db
              .select()
              .from(factoryBaleProducts)
              .where(
                and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.articleCode, articleCode))
              );

            if (!existing) {
              [existing] = await db
                .select()
                .from(factoryBaleProducts)
                .where(and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.code, code)));
            }

            const hasPriceData =
              (productionPrice !== null && parseFloat(productionPrice) > 0) ||
              (sellingPrice !== null && parseFloat(sellingPrice) > 0);

            if (existing) {
              await db
                .update(factoryBaleProducts)
                .set({
                  name,
                  description,
                  weightPerBaleKg: weightPerBaleKg ? String(weightPerBaleKg) : existing.weightPerBaleKg,
                  categoryId: categoryId || existing.categoryId,
                  ...(sellingPrice !== null ? { sellingPrice } : {}),
                  ...(productionPrice !== null ? { productionPrice } : {}),
                  updatedAt: new Date(),
                })
                .where(eq(factoryBaleProducts.id, existing.id));
              await db
                .update(factoryBales)
                .set({ productName: name, updatedAt: new Date() })
                .where(eq(factoryBales.productId, existing.id));
              updated++;
              if (hasPriceData) pricesUpdated++;
            } else {
              await db.insert(factoryBaleProducts).values({
                companyId,
                code,
                articleCode,
                name,
                description,
                weightPerBaleKg: weightPerBaleKg ? String(weightPerBaleKg) : null,
                categoryId,
                ...(sellingPrice !== null ? { sellingPrice } : {}),
                ...(productionPrice !== null ? { productionPrice } : {}),
              });
              created++;
              if (hasPriceData) pricesUpdated++;
            }
          }

          res.json({
            created,
            updated,
            categoriesCreated,
            pricesUpdated,
            skippedNoArticleCode,
            detectedColumns: {
              articleCode: detectedArticleCodeCol,
              productionPrice: detectedProductionPriceCol,
              sellingPrice: detectedSellingPriceCol,
            },
          });
        } catch (innerError: unknown) {
          logger.error("Error processing Excel import:", { error: innerError });
          res.status(500).json({ message: getErrorMessage(innerError) });
        }
      });
    } catch (error: unknown) {
      logger.error("Error in Excel import:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/bales/validate-import", requireAuth, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({ storage: multer.memoryStorage() });

      upload.single("file")(req, res, async (err) => {
        try {
          if (err) return res.status(400).json({ message: getErrorMessage(err) });

          const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
          if (!companyId) return res.status(400).json({ message: "No company selected" });

          if (!req.file) return res.status(400).json({ message: "No file uploaded" });

          const XLSX = await import("xlsx-js-style");
          const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
          const sheetName = workbook.SheetNames[0];
          const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]);

          const getVal = (row: Record<string, unknown>, ...keys: string[]) => {
            const rowKeys = Object.keys(row);
            for (const k of keys) {
              const found = rowKeys.find((rk) => rk.trim().toLowerCase() === k.toLowerCase());
              if (found && row[found] !== undefined && row[found] !== null && String(row[found]).trim() !== "")
                return row[found];
            }
            return undefined;
          };

          const allProducts = await db
            .select()
            .from(factoryBaleProducts)
            .where(eq(factoryBaleProducts.companyId, companyId));
          const productByArticle = new Map();
          for (const p of allProducts) {
            if (p.articleCode) productByArticle.set(p.articleCode.trim().toUpperCase(), p);
          }

          const validRows: {
            rowIndex: number;
            articleCode: string;
            productName: string;
            productId: number;
            quantity: number;
            weight: number;
            productionDate: string;
          }[] = [];
          const skippedRows: { rowIndex: number; articleCode: string; reason: string }[] = [];

          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const rawCode = getVal(
              row,
              "ITEM BARCODE",
              "Item Barcode",
              "itemBarcode",
              "articleCode",
              "article_code",
              "ArticleCode",
              "Article Code",
              "barcode",
              "Barcode",
              "ITEM NAME",
              "Item Name"
            );
            const articleCode = rawCode ? String(rawCode).trim().toUpperCase() : "";
            if (!articleCode) {
              skippedRows.push({ rowIndex: i + 2, articleCode: "", reason: "Empty article code" });
              continue;
            }

            const product = productByArticle.get(articleCode);
            if (!product) {
              skippedRows.push({ rowIndex: i + 2, articleCode, reason: "Article code not found in products" });
              continue;
            }

            const rawQty = parseInt(String(getVal(row, "QUANTITY", "Quantity", "quantity", "qty", "Qty") ?? "1"));
            if (isNaN(rawQty) || rawQty <= 0) {
              skippedRows.push({ rowIndex: i + 2, articleCode, reason: "Invalid quantity (must be > 0)" });
              continue;
            }
            const weight = parseFloat(String(product.weightPerBaleKg || "25"));

            let prodDate: Date | null = null;
            const rawDate = getVal(
              row,
              "PRODUCTION DATE",
              "Production Date",
              "productionDate",
              "production_date",
              "date",
              "Date"
            );
            if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
              prodDate = rawDate;
            } else if (rawDate) {
              const dateStr = String(rawDate).trim();
              const parsed = new Date(dateStr);
              if (!isNaN(parsed.getTime())) {
                prodDate = parsed;
              }
            }
            if (!prodDate) {
              skippedRows.push({ rowIndex: i + 2, articleCode, reason: "No valid production date" });
              continue;
            }

            validRows.push({
              rowIndex: i + 2,
              articleCode,
              productName: product.name,
              productId: product.id,
              quantity: rawQty,
              weight,
              productionDate: prodDate.toISOString().split("T")[0],
            });
          }

          const totalBales = validRows.reduce((sum, r) => sum + r.quantity, 0);
          const totalWeight = validRows.reduce((sum, r) => sum + r.quantity * r.weight, 0);

          return res.json({
            totalRows: rows.length,
            validRows,
            skippedRows,
            totalBales,
            totalWeight,
            totalProducts: allProducts.length,
          });
        } catch (innerErr: unknown) {
          logger.error("Validate import error:", { error: innerErr });
          return res.status(500).json({ message: getErrorMessage(innerErr) });
        }
      });
    } catch (outerErr: unknown) {
      logger.error("Validate import outer error:", { error: outerErr });
      res.status(500).json({ message: getErrorMessage(outerErr) });
    }
  });

  app.post("/api/factory/bales/import-excel", requireAuth, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({ storage: multer.memoryStorage() });

      upload.single("file")(req, res, async (err) => {
        try {
          if (err) return res.status(400).json({ message: getErrorMessage(err) });

          const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
          if (!companyId) return res.status(400).json({ message: "No company selected" });

          if (!req.file) return res.status(400).json({ message: "No file uploaded" });

          const locationId = req.body.locationId ? (parseId(req.body.locationId) ?? -1) : null;

          const XLSX = await import("xlsx-js-style");
          const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
          const sheetName = workbook.SheetNames[0];
          const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]);

          const getVal = (row: Record<string, unknown>, ...keys: string[]) => {
            const rowKeys = Object.keys(row);
            for (const k of keys) {
              const found = rowKeys.find((rk) => rk.trim().toLowerCase() === k.toLowerCase());
              if (found && row[found] !== undefined && row[found] !== null && String(row[found]).trim() !== "")
                return row[found];
            }
            return undefined;
          };

          const allProducts = await db
            .select()
            .from(factoryBaleProducts)
            .where(eq(factoryBaleProducts.companyId, companyId));
          const productByArticle = new Map();
          for (const p of allProducts) {
            if (p.articleCode) productByArticle.set(p.articleCode.trim().toUpperCase(), p);
          }

          let totalBalesCreated = 0;
          let skippedRows = 0;
          const skippedDetails: string[] = [];

          type ImportedProduct = (typeof allProducts)[number];
          const rowGroups: { product: ImportedProduct; qty: number; weight: number; prodDate: Date }[] = [];
          let totalBalesNeeded = 0;

          logger.info(`Bale import: processing ${rows.length} rows`, {
            firstRowKeys: rows.length > 0 ? Object.keys(rows[0]) : "none",
          });

          for (const row of rows) {
            const rawCode = getVal(
              row,
              "ITEM BARCODE",
              "Item Barcode",
              "itemBarcode",
              "articleCode",
              "article_code",
              "ArticleCode",
              "Article Code",
              "barcode",
              "Barcode"
            );
            const articleCode = rawCode ? String(rawCode).trim().toUpperCase() : "";
            if (!articleCode) {
              skippedRows++;
              skippedDetails.push("Row with empty article code");
              continue;
            }

            const product = productByArticle.get(articleCode);
            if (!product) {
              skippedRows++;
              skippedDetails.push(`Article code "${articleCode}" not found in products`);
              continue;
            }

            const rawQty = parseInt(String(getVal(row, "QUANTITY", "Quantity", "quantity", "qty", "Qty") ?? "1"));
            if (isNaN(rawQty) || rawQty <= 0) {
              skippedRows++;
              skippedDetails.push(`Article "${articleCode}" has invalid quantity`);
              continue;
            }
            const qty = rawQty;
            const weight = parseFloat(String(product.weightPerBaleKg || "25"));

            let prodDate: Date | null = null;
            const rawDate = getVal(
              row,
              "PRODUCTION DATE",
              "Production Date",
              "productionDate",
              "production_date",
              "date",
              "Date"
            );
            if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
              prodDate = rawDate;
            } else if (rawDate) {
              const dateStr = String(rawDate).trim();
              const parsed = new Date(dateStr);
              if (!isNaN(parsed.getTime())) {
                prodDate = parsed;
              }
            }
            if (!prodDate) {
              skippedRows++;
              skippedDetails.push(`Article "${articleCode}" has no valid production date`);
              continue;
            }

            rowGroups.push({ product, qty, weight, prodDate });
            totalBalesNeeded += qty;
          }

          if (rowGroups.length === 0) {
            return res.json({ totalBalesCreated: 0, skippedRows, skippedDetails: skippedDetails.slice(0, 20) });
          }

          await db.transaction(async (tx) => {
            const [seqRecord] = await tx
              .select()
              .from(factoryBaleSequences)
              .where(eq(factoryBaleSequences.companyId, companyId))
              .for("update");

            let nextNumber: number;
            if (seqRecord) {
              nextNumber = seqRecord.nextNumber;
              await tx
                .update(factoryBaleSequences)
                .set({ nextNumber: nextNumber + totalBalesNeeded })
                .where(eq(factoryBaleSequences.id, seqRecord.id));
            } else {
              nextNumber = 200000;
              await tx.insert(factoryBaleSequences).values({
                companyId,
                nextNumber: 200000 + totalBalesNeeded,
              });
            }

            let baleIndex = 0;
            for (const group of rowGroups) {
              for (let i = 0; i < group.qty; i++) {
                const refNum = `REF${String(nextNumber + baleIndex).padStart(6, "0")}`;
                await tx.insert(factoryBales).values({
                  companyId,
                  mixBatchId: null,
                  productId: group.product.id,
                  erpLocationId: locationId,
                  baleCode: group.product.code,
                  referenceNumber: refNum,
                  articleCode: group.product.articleCode,
                  productName: group.product.name,
                  weightKg: String(group.weight),
                  costPerKg: "0",
                  totalCost: "0",
                  status: "IN_STOCK",
                  finalizedAt: group.prodDate,
                  createdAt: group.prodDate,
                });
                baleIndex++;
              }
              totalBalesCreated += group.qty;
            }
          });

          if (totalBalesCreated > 0) {
            const excelImportToday = getClientDate(req);
            await writeDaybookEntry(db, {
              companyId,
              txDate: excelImportToday,
              txType: "BALE_IMPORT",
              description: `Bale Excel import: ${totalBalesCreated} bale${totalBalesCreated !== 1 ? "s" : ""} created${skippedRows > 0 ? ` (${skippedRows} rows skipped)` : ""}`,
            });
          }
          res.json({ totalBalesCreated, skippedRows, skippedDetails: skippedDetails.slice(0, 20) });
        } catch (innerError: unknown) {
          logger.error("Error processing bale Excel import:", { error: innerError });
          res.status(500).json({ message: getErrorMessage(innerError) });
        }
      });
    } catch (error: unknown) {
      logger.error("Error in bale Excel import:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
