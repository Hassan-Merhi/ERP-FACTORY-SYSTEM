// Extracted from ./registerProductionBaleRoutesPart2.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { insertProductionBaleSchema } from "@shared/schema";
import { getBwipjs } from "./registerProductionBaleRoutesPart1";
import { validateRequest } from "../lib/validateRequest";
import {
  bulkCreateInput,
  createInput,
  deleteInput,
  generateBarcodeInput,
  scanInput,
} from "./registerProductionBaleRoutesSchemas";

export function registerProductionBaleRoutesPart3(app: Express) {
  app.post("/api/production-bales", requireAuth, validateRequest(createInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const data = insertProductionBaleSchema.parse({ ...req.body, companyId });

      const bale = await storage.createProductionBale(data);
      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error creating production bale:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/production-bales/bulk", requireAuth, validateRequest(bulkCreateInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const balesData = req.body.bales || [];

      if (!Array.isArray(balesData)) {
        return res.status(400).json({ message: "Invalid data format" });
      }

      const validatedBales = balesData.map((b) => insertProductionBaleSchema.parse({ ...b, companyId }));

      const created = await storage.bulkCreateProductionBales(validatedBales);
      res.json({ success: true, count: created.length, bales: created });
    } catch (error: unknown) {
      logger.error("Error bulk creating bales:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/production-bales/next-barcode", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const barcode = await storage.getNextBaleBarcode(companyId);
      res.json({ barcode });
    } catch (error: unknown) {
      logger.error("Error generating barcode:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/production-bales/scan", requireAuth, validateRequest(scanInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { barcodeValue, weightKg, category, grade, warehouseLocation } = req.body;

      if (!barcodeValue || !weightKg || !category || !grade) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const bale = await storage.updateProductionBaleFromScan(barcodeValue, companyId, {
        weightKg,
        category,
        grade,
        warehouseLocation,
      });

      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error updating bale from scan:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/generate-barcode", requireAuth, validateRequest(generateBarcodeInput), async (req, res) => {
    try {
      const { text } = req.body;

      if (!text) {
        return res.status(400).json({ message: "Barcode text is required" });
      }

      const bwipjs = await getBwipjs();

      // Render to PNG buffer
      const png = await bwipjs.toBuffer({
        bcid: "code128",
        text: text,
        scale: 3,
        height: 10,
        includetext: true,
        textxalign: "center",
      });

      // Convert to base64 data URL
      const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
      res.json({ dataUrl });
    } catch (error: unknown) {
      logger.error("Error generating barcode:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET endpoint to return barcode as PNG image (for print labels)
  app.get("/api/barcode/:code", requireAuth, async (req, res) => {
    try {
      const code = decodeURIComponent(req.params.code);

      if (!code) {
        return res.status(400).json({ message: "Barcode code is required" });
      }

      const bwipjs = await getBwipjs();

      const png = await bwipjs.toBuffer({
        bcid: "code128",
        text: code,
        scale: 14,
        height: 40,
        includetext: false,
        textxalign: "center",
        barcolor: "000000",
      });

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.send(png);
    } catch (error: unknown) {
      logger.error("Error generating barcode image:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/production-bales/:id", requireAuth, validateRequest(deleteInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bale ID" });
      await storage.deleteProductionBale(id, companyId);
      res.json({ success: true });
    } catch (error: unknown) {
      logger.error("Error deleting production bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
