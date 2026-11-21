// Extracted from ./baleProductRoutes.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { insertBaleProductSchema, insertBaleProductCategorySchema } from "@shared/schema";

export function registerBaleProductRoutesPart1(app: Express) {
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
}
