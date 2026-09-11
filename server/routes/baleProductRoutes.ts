/**
 * Bale-product catalog + pending-barcode routes.
 *
 * Pending barcode labels, bale-product categories, and bale products
 * (CRUD + Excel import). Extracted from baleRoutes.ts as a sub-registrar;
 * behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { upload } from "./_helpers";
import { readExcel, sheetToJson } from "../excelHelper";
import {
  baleProducts,
  baleProductCategories,
  insertBaleProductSchema,
  insertPendingBarcodeSchema,
  insertBaleProductCategorySchema,
} from "@shared/schema";

export function registerBaleProductRoutes(app: Express) {
  // Pending Barcodes API Routes - for pre-printing barcode labels
  app.get("/api/pending-barcodes", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const barcodes = await storage.getAllPendingBarcodes(companyId);
      res.json(barcodes);
    } catch (error: unknown) {
      logger.error("Error fetching pending barcodes:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pending-barcodes/:barcode", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const barcode = await storage.getPendingBarcodeByCode(req.params.barcode, companyId);
      if (!barcode) {
        return res.status(404).json({ message: "Barcode not found" });
      }
      res.json(barcode);
    } catch (error: unknown) {
      logger.error("Error fetching pending barcode:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pending-barcodes", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const data = insertPendingBarcodeSchema.parse({ ...req.body, companyId });
      const barcode = await storage.createPendingBarcode(data);
      res.json(barcode);
    } catch (error: unknown) {
      logger.error("Error creating pending barcode:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pending-barcodes/import", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const barcodes = req.body.barcodes || [];
      if (!Array.isArray(barcodes)) {
        return res.status(400).json({ message: "Invalid data format" });
      }
      const created = await storage.bulkCreatePendingBarcodes(
        barcodes.map((b) => ({
          companyId,
          barcode: b.barcode || b.code || b,
          category: b.category || null,
          grade: b.grade || null,
          origin: b.origin || null,
          printed: false,
          used: false,
        }))
      );
      res.json({ success: true, count: created.length, barcodes: created });
    } catch (error: unknown) {
      logger.error("Error importing pending barcodes:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/pending-barcodes/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid barcode ID" });
      const barcode = await storage.updatePendingBarcode(id, req.body);
      res.json(barcode);
    } catch (error: unknown) {
      logger.error("Error updating pending barcode:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/pending-barcodes/mark-printed", requireAuth, async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids)) {
        return res.status(400).json({ message: "ids must be an array" });
      }
      await storage.markBarcodesAsPrinted(ids);
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error marking barcodes as printed:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/pending-barcodes/:id", requireAuth, async (req, res) => {
    try {
      const _bid = parseInt(req.params.id, 10);
      if (isNaN(_bid)) return res.status(400).json({ message: "Invalid barcode ID" });
      await storage.deletePendingBarcode(_bid);
      res.status(204).send();
    } catch (error: unknown) {
      logger.error("Error deleting pending barcode:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
  // Bale Product Categories API Routes
  app.get("/api/bale-product-categories", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const categories = await storage.getAllBaleProductCategories(companyId);
      res.json(categories);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bale-product-categories", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const data = insertBaleProductCategorySchema.parse({ ...req.body, companyId });
      const existing = await storage.getBaleProductCategoryByName(data.name, companyId);
      if (existing) return res.status(409).json({ message: `Category "${data.name}" already exists` });
      const created = await storage.createBaleProductCategory(data);
      res.json(created);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/bale-product-categories/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid category ID" });
      const existing = await storage.getBaleProductCategoryById(id);
      if (!existing) return res.status(404).json({ message: "Category not found" });
      const updated = await storage.updateBaleProductCategory(id, req.body);
      res.json(updated);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/bale-product-categories/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid category ID" });
      const existing = await storage.getBaleProductCategoryById(id);
      if (!existing) return res.status(404).json({ message: "Category not found" });
      await storage.deleteBaleProductCategory(id);
      res.json({ success: true });
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Bale Products API Routes
  app.get("/api/bale-products", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const products = await storage.getAllBaleProducts(companyId);
      res.json(products);
    } catch (error: unknown) {
      logger.error("Error fetching bale products:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/bale-products/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const product = await storage.getBaleProductById(id);
      if (!product) {
        return res.status(404).json({ message: "Product not found" });
      }

      res.json(product);
    } catch (error: unknown) {
      logger.error("Error fetching bale product:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bale-products", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      let articleCode = req.body.articleCode || "";
      if (!articleCode && req.body.itemNumber) {
        const num = parseInt(String(req.body.itemNumber));
        if (!isNaN(num) && num >= 1 && num <= 99) {
          articleCode = `HMD${String(num).padStart(2, "0")}000`;
        }
      }
      const code = req.body.code || articleCode || `AUTO-${Date.now()}`;
      const data = insertBaleProductSchema.parse({
        ...req.body,
        companyId,
        articleCode: articleCode || undefined,
        code,
      });

      if (articleCode) {
        const existingByArticle = await storage.getBaleProductByArticleCode(articleCode, companyId);
        if (existingByArticle) {
          return res.status(409).json({ message: "Article code already exists" });
        }
      }

      const product = await storage.createBaleProduct(data);
      res.json(product);
    } catch (error: unknown) {
      logger.error("Error creating bale product:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/bale-products/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const existing = await storage.getBaleProductById(id);
      if (!existing) {
        return res.status(404).json({ message: "Product not found" });
      }

      if (existing.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied" });
      }
      const data = insertBaleProductSchema.partial().parse(req.body);

      const product = await storage.updateBaleProduct(id, data);
      res.json(product);
    } catch (error: unknown) {
      logger.error("Error updating bale product:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/bale-products/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid product ID" });
      }

      const existing = await storage.getBaleProductById(id);
      if (!existing) {
        return res.status(404).json({ message: "Product not found" });
      }

      if (existing.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      await storage.deleteBaleProduct(id);
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting bale product:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/bale-products/import-excel", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      const workbook = await readExcel(req.file.buffer);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = sheetToJson(worksheet);

      let created = 0;
      let updated = 0;
      let categoriesCreated = 0;

      await db.transaction(async (tx) => {
        const categoryCache: Record<string, number> = {};
        const existingCategories = await tx
          .select()
          .from(baleProductCategories)
          .where(eq(baleProductCategories.companyId, companyId));
        for (const cat of existingCategories) {
          categoryCache[cat.name.toLowerCase()] = cat.id;
        }

        for (const row of rows) {
          const itemNumber = row.itemNumber || row.item_number || row.ItemNumber;
          let articleCode = (row.articleCode || row.article_code || row.ArticleCode || "") as string;
          if (!articleCode && itemNumber) {
            const num = parseInt(String(itemNumber));
            if (!isNaN(num) && num >= 1 && num <= 99) {
              articleCode = `HMD${String(num).padStart(2, "0")}000`;
            }
          }

          if (!articleCode) continue;

          const name = (row.name || row.Name || row.product_name || "") as string;
          if (!name) continue;

          const categoryName = String(row.category || row.Category || row.category_name || "").trim();
          let categoryId: number | null = null;

          if (categoryName) {
            const lowerCat = categoryName.toLowerCase();
            if (categoryCache[lowerCat]) {
              categoryId = categoryCache[lowerCat];
            } else {
              const [newCat] = await tx
                .insert(baleProductCategories)
                .values({
                  companyId,
                  name: categoryName,
                  isActive: true,
                })
                .returning();
              categoryCache[lowerCat] = newCat.id;
              categoryId = newCat.id;
              categoriesCreated++;
            }
          }

          const code = (row.code || row.Code || row.product_code || articleCode) as string;
          const description = (row.description || row.Description || "") as string;
          const weightPerBaleKg = row.weightPerBaleKg || row.weight_per_bale_kg || row.weight || undefined;
          const active = row.active === undefined ? true : Boolean(row.active);

          const [existing] = await tx
            .select()
            .from(baleProducts)
            .where(and(eq(baleProducts.articleCode, articleCode), eq(baleProducts.companyId, companyId)));

          if (existing) {
            await tx
              .update(baleProducts)
              .set({
                name,
                description: description || existing.description,
                weightPerBaleKg: weightPerBaleKg ? String(weightPerBaleKg) : existing.weightPerBaleKg,
                categoryId: categoryId ?? existing.categoryId,
                active,
                updatedAt: sql`now()`,
              })
              .where(eq(baleProducts.id, existing.id));
            updated++;
          } else {
            await tx.insert(baleProducts).values({
              companyId,
              code,
              articleCode,
              name,
              description,
              weightPerBaleKg: weightPerBaleKg ? String(weightPerBaleKg) : undefined,
              categoryId,
              active,
            });
            created++;
          }
        }
      });

      res.json({ success: true, created, updated, categoriesCreated, count: created + updated });
    } catch (error: unknown) {
      logger.error("Error importing bale products from Excel:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
