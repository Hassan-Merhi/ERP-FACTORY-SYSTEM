// Extracted from ./productImportRoutes.ts to keep that module under the source-size cap.
import { spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { toMoney } from "../../../lib/money";
import { factoryBaleProducts, factoryBales, factoryCategories } from "@shared/schema";
import { and, eq } from "drizzle-orm";

export function registerFactoryProductImportRoutesPart1(app: Express) {
  app.post("/api/factory/bale-products/import-excel", requireAuth, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: spreadsheetImportLimitBytes(req.session?.currentRole), files: 1 },
      });

      upload.single("file")(req, res, async (err) => {
        try {
          if (err)
            return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
              message:
                err.code === "LIMIT_FILE_SIZE"
                  ? "Excel file exceeds the 50 MB standard / 100 MB admin limit."
                  : getErrorMessage(err),
            });

          const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
          if (!companyId) return res.status(400).json({ message: "No company selected" });

          if (!req.file) return res.status(400).json({ message: "No file uploaded" });

          const {
            read: readExcel,
            utils: { sheet_to_json: sheetToJson },
          } = (await import("xlsx-js-style")).default;
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
                ? String(toMoney(String(rawSellingPrice ?? "")).toNumber())
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
                ? String(toMoney(String(rawProductionPrice ?? "")).toNumber())
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
              (productionPrice !== null && toMoney(productionPrice).toNumber() > 0) ||
              (sellingPrice !== null && toMoney(sellingPrice).toNumber() > 0);

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
}
