/**
 * factoryProductsRoutes: FactoryProductImage endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, NextFunction, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryBaleProductImages } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";
import multer from "multer";
import path from "path";
import fs from "fs";
import { validateRequest } from "../../../lib/validateRequest";
import { deleteFactoryByIdInput, uploadProductImageInput } from "./factoryProductRouteSchemas";

export function registerFactoryProductImageRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // 4. Factory Containers CRUD
  // ───────────────────────────────────────────────

  // ── Bale Product Images ──────────────────────────────────────────────────────
  const productImageStorage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(process.cwd(), "uploads", "product-images");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `prod-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  });
  const productImageUpload = multer({
    storage: productImageStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith("image/")) cb(null, true);
      else cb(new Error("Only image files are allowed"));
    },
  });

  app.get("/api/factory/bale-product-images", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { articleCode } = req.query;
      const conditions = [eq(factoryBaleProductImages.companyId, companyId)];
      if (articleCode) conditions.push(eq(factoryBaleProductImages.articleCode, String(articleCode)));
      const images = await db
        .select()
        .from(factoryBaleProductImages)
        .where(and(...conditions))
        .orderBy(asc(factoryBaleProductImages.sortOrder), asc(factoryBaleProductImages.uploadedAt));
      res.json(images);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // Multer runs as middleware so validateRequest sees the parsed form fields.
  function uploadProductImage(req: Request, res: Response, next: NextFunction) {
    productImageUpload.single("image")(req, res, (err) => {
      if (err) return res.status(400).json({ message: getErrorMessage(err) });
      next();
    });
  }

  app.post(
    "/api/factory/bale-product-images",
    requireAuth,
    uploadProductImage,
    validateRequest(uploadProductImageInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!req.file) return res.status(400).json({ message: "No image uploaded" });
        const { articleCode, productId } = req.body;
        if (!articleCode) return res.status(400).json({ message: "articleCode is required" });
        const url = `/api/factory/uploads/product-images/${req.file.filename}`;
        const [created] = await db
          .insert(factoryBaleProductImages)
          .values({
            companyId,
            articleCode,
            productId: productId ? parseInt(productId) : null,
            url,
            fileName: req.file.originalname,
            sortOrder: 0,
          })
          .returning();
        res.json(created);
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  app.delete(
    "/api/factory/bale-product-images/:id",
    requireAuth,
    validateRequest(deleteFactoryByIdInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });
        const [img] = await db
          .select()
          .from(factoryBaleProductImages)
          .where(and(eq(factoryBaleProductImages.id, id), eq(factoryBaleProductImages.companyId, companyId)));
        if (!img) return res.status(404).json({ message: "Image not found" });
        // Delete physical file
        const filename = img.url.split("/").pop();
        if (filename) {
          const filePath = path.join(process.cwd(), "uploads", "product-images", filename);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        await db
          .delete(factoryBaleProductImages)
          .where(and(eq(factoryBaleProductImages.id, id), eq(factoryBaleProductImages.companyId, companyId)));
        res.json({ ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );
}
