// Extracted from ./productionBaleRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { sumMoney, toMoney } from "../lib/money";
import { insertProductionBaleSchema, mixBatches, pressingBatches, productionBales } from "@shared/schema";
import { getBwipjs } from "./registerProductionBaleRoutesPart1";
import { z } from "zod";
import { emptyBody, emptyQuery, stringParam, validateRequest, type RequestSchemas } from "../lib/validateRequest";

const looseNumber = z.union([z.number(), z.string()]);
/** The handlers parse the body with insertProductionBaleSchema after setting companyId from the session. */
const productionBaleBody = insertProductionBaleSchema.omit({ companyId: true }).strict();
/** parseInt(req.params.id): any string reaches the handler, which answers 400 for NaN. */
const baleIdParams = z.strictObject({ id: stringParam });

const finalizeInput = {
  query: emptyQuery,
  body: z.strictObject({
    pressingBatchId: looseNumber.nullable().optional(),
    scannedBaleIds: z.array(looseNumber).optional(),
    locationId: looseNumber.nullable().optional(),
    mixBatchId: looseNumber.nullable().optional(),
  }),
} satisfies RequestSchemas;
const createInput = { query: emptyQuery, body: productionBaleBody } satisfies RequestSchemas;
const bulkCreateInput = {
  query: emptyQuery,
  body: z.strictObject({ bales: z.array(productionBaleBody).nullable().optional() }),
} satisfies RequestSchemas;
const scanInput = {
  query: emptyQuery,
  body: z.strictObject({
    barcodeValue: z.string().optional(),
    weightKg: looseNumber.optional(),
    category: z.string().optional(),
    grade: z.string().optional(),
    warehouseLocation: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;
const generateBarcodeInput = {
  query: emptyQuery,
  body: z.strictObject({ text: z.union([z.string(), z.number()]).optional() }),
} satisfies RequestSchemas;
const deleteInput = { params: baleIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;
const statusInput = {
  params: baleIdParams,
  query: emptyQuery,
  body: z.strictObject({ status: z.string().optional() }),
} satisfies RequestSchemas;

export function registerProductionBaleRoutesPart2(app: Express) {
  app.post("/api/production-bales/finalize", requireAuth, validateRequest(finalizeInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { pressingBatchId, scannedBaleIds, locationId, mixBatchId } = req.body;
      if (!locationId) return res.status(400).json({ message: "Location is required" });
      if (!pressingBatchId) return res.status(400).json({ message: "Pressing batch ID is required" });
      if (!mixBatchId) return res.status(400).json({ message: "Mix batch is required for raw material consumption" });
      if (!Array.isArray(scannedBaleIds) || scannedBaleIds.length === 0) {
        return res.status(400).json({ message: "No bale IDs provided" });
      }

      const [batch] = await db
        .select()
        .from(pressingBatches)
        .where(and(eq(pressingBatches.id, parseInt(pressingBatchId)), eq(pressingBatches.companyId, companyId)));

      if (!batch) return res.status(404).json({ message: "Pressing batch not found" });
      if (batch.status === "FINALIZED")
        return res.status(400).json({ message: "This pressing batch has already been finalized" });

      const mixBatch = await storage.getMixBatchById(parseInt(mixBatchId), companyId);
      if (!mixBatch) return res.status(404).json({ message: "Mix batch not found" });

      const pendingBales = await db
        .select()
        .from(productionBales)
        .where(
          and(
            eq(productionBales.pressingBatchId, batch.id),
            eq(productionBales.companyId, companyId),
            eq(productionBales.status, "PENDING")
          )
        );

      const expectedCount = pendingBales.length;
      const scannedIds = scannedBaleIds.map((id) => parseInt(id));

      if (scannedIds.length !== expectedCount) {
        return res.status(400).json({
          message: `Count mismatch: expected ${expectedCount}, scanned ${scannedIds.length}`,
          expected: expectedCount,
          scanned: scannedIds.length,
        });
      }

      const pendingBaleIds = new Set(pendingBales.map((b) => b.id));
      const invalidIds = scannedIds.filter((id: number) => !pendingBaleIds.has(id));
      if (invalidIds.length > 0) {
        return res.status(400).json({
          message: `Some scanned bales do not belong to this pressing batch or are not pending`,
          invalidIds,
        });
      }

      const scannedBaleRecords = pendingBales.filter((b) => scannedIds.includes(b.id));
      const totalWeight = sumMoney(scannedBaleRecords.map((b) => b.weightKg));
      const mixRemainingKg = toMoney(mixBatch.totalWeightKg).minus(toMoney(mixBatch.usedKg));
      if (totalWeight.gt(mixRemainingKg.plus(0.001))) {
        return res.status(400).json({
          message: `Not enough remaining in mix batch. Available: ${mixRemainingKg.toFixed(3)} kg, Required: ${totalWeight.toFixed(3)} kg`,
        });
      }

      const costPerKg = toMoney(mixBatch.costPerKg);

      const updated = await db.transaction(async (tx) => {
        const finalizedBales = [];
        for (const baleId of scannedIds) {
          const baleRecord = scannedBaleRecords.find((b) => b.id === baleId);
          const baleTotalCost = toMoney(baleRecord?.weightKg).times(costPerKg).toFixed(2);

          const [updatedBale] = await tx
            .update(productionBales)
            .set({
              locationId: parseInt(locationId),
              mixBatchId: parseInt(mixBatchId),
              costPerKg: costPerKg.toString(),
              totalCost: baleTotalCost,
              status: "IN_STOCK",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(productionBales.id, baleId),
                eq(productionBales.companyId, companyId),
                eq(productionBales.status, "PENDING")
              )
            )
            .returning();

          if (updatedBale) finalizedBales.push(updatedBale);
        }

        const newUsedKg = toMoney(mixBatch.usedKg).plus(totalWeight);
        await tx
          .update(mixBatches)
          .set({
            usedKg: newUsedKg.toFixed(3),
            updatedAt: sql`now()`,
          })
          .where(eq(mixBatches.id, parseInt(mixBatchId)));

        await tx
          .update(pressingBatches)
          .set({
            status: "FINALIZED",
            mixBatchId: parseInt(mixBatchId),
            finalizedAt: new Date(),
            finalizedLocationId: parseInt(locationId),
          })
          .where(eq(pressingBatches.id, batch.id));

        return finalizedBales;
      });

      res.json({ updated: updated.length, bales: updated, pressingBatchId: batch.id });
    } catch (error: unknown) {
      logger.error("Error finalizing bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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

  app.patch("/api/production-bales/:id/status", requireAuth, validateRequest(statusInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid bale ID" });
      const { status } = req.body;
      const validStatuses = ["PENDING", "LABEL_PRINTED", "PRESSED", "IN_STOCK", "RESERVED", "SOLD"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      }
      const { eq, and } = await import("drizzle-orm");

      const [updated] = await db
        .update(productionBales)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(productionBales.id, id), eq(productionBales.companyId, companyId)))
        .returning();

      if (!updated) {
        return res.status(404).json({ message: "Bale not found" });
      }

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating bale status:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
