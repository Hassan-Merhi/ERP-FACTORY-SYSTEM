/**
 * Production-bale routes.
 *
 * Production bales, pressing batches, barcode generation/lookup, and the
 * production-bale Excel import. Extracted from baleRoutes.ts as a
 * sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, or, desc, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { upload } from "./_helpers";
import { readExcel, sheetToJson } from "../excelHelper";
import {
  baleProducts,
  baleSequences,
  mixBatches,
  pressingBatches,
  productionBales,
  insertProductionBaleSchema,
} from "@shared/schema";

// Module-level bwip-js cache — loaded once on first barcode request, then reused.
// This avoids the cold-start latency of re-importing the library on every request.
type BwipJsModule = typeof import("bwip-js");
let _bwipjs: BwipJsModule | null = null;
async function getBwipjs(): Promise<BwipJsModule> {
  if (!_bwipjs) {
    _bwipjs = await import("bwip-js");
  }
  return _bwipjs;
}

export function registerProductionBaleRoutes(app: Express) {
  // Production Bales API Routes
  app.get("/api/production-bales", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const filters: { mixBatchId?: number; status?: string; category?: string; grade?: string } = {};
      if (req.query.mixBatchId) filters.mixBatchId = parseInt(req.query.mixBatchId as string);
      if (req.query.status) filters.status = req.query.status as string;
      if (req.query.category) filters.category = req.query.category as string;
      if (req.query.grade) filters.grade = req.query.grade as string;

      const bales = await storage.getAllProductionBales(companyId, filters);
      res.json(bales);
    } catch (error: unknown) {
      logger.error("Error fetching production bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/production-bales/barcode/:barcode", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const bale = await storage.getProductionBaleByBarcode(req.params.barcode, companyId);

      if (!bale) {
        return res.status(404).json({ message: "Bale not found" });
      }

      res.json(bale);
    } catch (error: unknown) {
      logger.error("Error fetching bale by barcode:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/production-bales/create-batch", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { mixBatchId, productId, locationId, quantity, weightPerBale, mode } = req.body;

      const isPressing = mode === "pressing";

      if (!productId || !quantity || !weightPerBale) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      if (!isPressing && !mixBatchId) {
        return res.status(400).json({ message: "Mix batch is required for counting mode" });
      }

      if (!isPressing && !locationId) {
        return res.status(400).json({ message: "Location is required for counting mode" });
      }

      const numBales = parseInt(quantity);
      const weight = parseFloat(weightPerBale);

      if (isNaN(numBales) || numBales < 1 || numBales > 1000) {
        return res.status(400).json({ message: "Quantity must be between 1 and 1000" });
      }

      if (isNaN(weight) || weight <= 0 || weight > 500) {
        return res.status(400).json({ message: "Weight must be between 1 and 500 kg" });
      }

      // Get product for bale code
      const [product] = await db.select().from(baleProducts).where(eq(baleProducts.id, productId));
      if (!product || product.companyId !== companyId) {
        return res.status(404).json({ message: "Product not found" });
      }

      let batch = null;
      let costPerKg = 0;
      let totalCostPerBale = "0";

      if (mixBatchId) {
        batch = await storage.getMixBatchById(mixBatchId, companyId);
        if (!batch) {
          return res.status(404).json({ message: "Mix batch not found" });
        }

        const totalWeight = weight * numBales;
        const remainingKg = parseFloat(batch.totalWeightKg) - parseFloat(batch.usedKg || "0");
        if (totalWeight > remainingKg + 0.001) {
          return res.status(400).json({
            message: `Not enough remaining in mix batch. Available: ${remainingKg.toFixed(3)} kg, Requested: ${totalWeight.toFixed(3)} kg`,
          });
        }
        costPerKg = parseFloat(batch.costPerKg);
        totalCostPerBale = (weight * costPerKg).toFixed(2);
      }

      const totalWeight = weight * numBales;

      // Wrap everything in a transaction for atomicity
      const result = await db.transaction(async (tx) => {
        const createdBales = [];

        let pressingBatchId: number | null = null;
        if (isPressing) {
          const [pb] = await tx
            .insert(pressingBatches)
            .values({
              companyId,
              mixBatchId: mixBatchId || null,
              productId,
              expectedCount: numBales,
              status: "PENDING",
              createdBy: req.session.userId || null,
            })
            .returning();
          pressingBatchId = pb.id;
        }

        // Create bales with unique barcodes (all within transaction)
        for (let i = 0; i < numBales; i++) {
          // Generate unique barcode within transaction
          const [sequence] = await tx
            .select()
            .from(baleSequences)
            .where(eq(baleSequences.companyId, companyId))
            .for("update"); // Lock the row

          let barcode: string;
          if (!sequence) {
            // Create new sequence
            const [newSeq] = await tx.insert(baleSequences).values({ companyId, nextNumber: 2 }).returning();
            barcode = `HD${String(newSeq.nextNumber - 1).padStart(5, "0")}`;
          } else {
            // Increment and use
            barcode = `HD${String(sequence.nextNumber).padStart(5, "0")}`;
            await tx
              .update(baleSequences)
              .set({ nextNumber: sequence.nextNumber + 1 })
              .where(eq(baleSequences.id, sequence.id));
          }

          // Create bale within transaction
          const baleData = {
            companyId,
            mixBatchId: mixBatchId || null,
            productId,
            locationId: isPressing ? null : locationId,
            pressingBatchId,
            baleCode: product.code,
            barcodeValue: barcode,
            quantity: 1,
            weightKg: weight.toString(),
            costPerKg: costPerKg > 0 ? costPerKg.toString() : "0",
            totalCost: costPerKg > 0 ? totalCostPerBale : "0",
            status: isPressing ? "PENDING" : "IN_STOCK",
            pressedAt: new Date(),
          };

          const [bale] = await tx.insert(productionBales).values(baleData).returning();
          createdBales.push(bale);
        }

        if (batch && mixBatchId) {
          const newUsedKg = parseFloat(batch.usedKg || "0") + totalWeight;
          await tx
            .update(mixBatches)
            .set({
              usedKg: newUsedKg.toFixed(3),
              updatedAt: sql`now()`,
            })
            .where(eq(mixBatches.id, mixBatchId));
        }

        return { bales: createdBales, pressingBatchId };
      });

      res.json({
        bales: result.bales,
        success: true,
        count: result.bales.length,
        pressingBatchId: result.pressingBatchId,
      });
    } catch (error: unknown) {
      logger.error("Error creating production bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/production-bales/pending", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const pending = await db
        .select({
          bale: productionBales,
          product: baleProducts,
          mixBatch: mixBatches,
        })
        .from(productionBales)
        .leftJoin(baleProducts, eq(productionBales.productId, baleProducts.id))
        .leftJoin(mixBatches, eq(productionBales.mixBatchId, mixBatches.id))
        .where(and(eq(productionBales.companyId, companyId), eq(productionBales.status, "PENDING")))
        .orderBy(desc(productionBales.createdAt));

      res.json(pending);
    } catch (error: unknown) {
      logger.error("Error fetching pending bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/production-bales/lookup/:barcode", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const barcode = req.params.barcode.trim();

      const results = await db
        .select({
          bale: productionBales,
          product: baleProducts,
          mixBatch: mixBatches,
        })
        .from(productionBales)
        .leftJoin(baleProducts, eq(productionBales.productId, baleProducts.id))
        .leftJoin(mixBatches, eq(productionBales.mixBatchId, mixBatches.id))
        .where(
          and(
            eq(productionBales.companyId, companyId),
            or(eq(productionBales.barcodeValue, barcode), eq(productionBales.baleCode, barcode))
          )
        );

      if (results.length === 0) {
        return res.status(404).json({ message: "Bale not found" });
      }

      res.json(results[0]);
    } catch (error: unknown) {
      logger.error("Error looking up bale:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pressing-batches", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const batches = await db
        .select({
          batch: pressingBatches,
          product: baleProducts,
          mixBatch: mixBatches,
        })
        .from(pressingBatches)
        .leftJoin(baleProducts, eq(pressingBatches.productId, baleProducts.id))
        .leftJoin(mixBatches, eq(pressingBatches.mixBatchId, mixBatches.id))
        .where(eq(pressingBatches.companyId, companyId))
        .orderBy(desc(pressingBatches.createdAt));

      const batchesWithBales = await Promise.all(
        batches.map(async (b) => {
          const bales = await db
            .select()
            .from(productionBales)
            .where(and(eq(productionBales.pressingBatchId, b.batch.id), eq(productionBales.companyId, companyId)));
          return {
            ...b,
            bales,
            pendingCount: bales.filter((bl) => bl.status === "PENDING").length,
            finalizedCount: bales.filter((bl) => bl.status !== "PENDING").length,
          };
        })
      );

      res.json(batchesWithBales);
    } catch (error: unknown) {
      logger.error("Error fetching pressing batches:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/pressing-batches/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const batchId = parseInt(req.params.id, 10);
      if (isNaN(batchId)) return res.status(400).json({ message: "Invalid batch ID" });

      const [batchRow] = await db
        .select({
          batch: pressingBatches,
          product: baleProducts,
          mixBatch: mixBatches,
        })
        .from(pressingBatches)
        .leftJoin(baleProducts, eq(pressingBatches.productId, baleProducts.id))
        .leftJoin(mixBatches, eq(pressingBatches.mixBatchId, mixBatches.id))
        .where(and(eq(pressingBatches.id, batchId), eq(pressingBatches.companyId, companyId)));

      if (!batchRow) return res.status(404).json({ message: "Pressing batch not found" });

      const bales = await db
        .select()
        .from(productionBales)
        .where(and(eq(productionBales.pressingBatchId, batchId), eq(productionBales.companyId, companyId)));

      res.json({
        ...batchRow,
        bales,
        pendingCount: bales.filter((b) => b.status === "PENDING").length,
        finalizedCount: bales.filter((b) => b.status !== "PENDING").length,
      });
    } catch (error: unknown) {
      logger.error("Error fetching pressing batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/production-bales/finalize", requireAuth, async (req, res) => {
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
      const totalWeight = scannedBaleRecords.reduce((sum, b) => sum + parseFloat(b.weightKg || "0"), 0);
      const mixRemainingKg = parseFloat(mixBatch.totalWeightKg) - parseFloat(mixBatch.usedKg || "0");
      if (totalWeight > mixRemainingKg + 0.001) {
        return res.status(400).json({
          message: `Not enough remaining in mix batch. Available: ${mixRemainingKg.toFixed(3)} kg, Required: ${totalWeight.toFixed(3)} kg`,
        });
      }

      const costPerKg = parseFloat(mixBatch.costPerKg);

      const updated = await db.transaction(async (tx) => {
        const finalizedBales = [];
        for (const baleId of scannedIds) {
          const baleRecord = scannedBaleRecords.find((b) => b.id === baleId);
          const baleWeight = parseFloat(baleRecord?.weightKg || "0");
          const baleTotalCost = (baleWeight * costPerKg).toFixed(2);

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

        const newUsedKg = parseFloat(mixBatch.usedKg || "0") + totalWeight;
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

  app.post("/api/production-bales", requireAuth, async (req, res) => {
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

  app.post("/api/production-bales/bulk", requireAuth, async (req, res) => {
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

  app.post("/api/production-bales/scan", requireAuth, async (req, res) => {
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

  app.post("/api/generate-barcode", requireAuth, async (req, res) => {
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

  app.delete("/api/production-bales/:id", requireAuth, async (req, res) => {
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

  app.patch("/api/production-bales/:id/status", requireAuth, async (req, res) => {
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

  app.patch("/api/production-bales/bulk-status", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { ids, status } = req.body;
      const validStatuses = ["PENDING", "LABEL_PRINTED", "PRESSED", "IN_STOCK", "RESERVED", "SOLD"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ message: "No bale IDs provided" });
      }
      const { eq, and, inArray } = await import("drizzle-orm");

      const updated = await db
        .update(productionBales)
        .set({ status, updatedAt: new Date() })
        .where(
          and(
            inArray(
              productionBales.id,
              ids.map((id) => parseInt(id))
            ),
            eq(productionBales.companyId, companyId)
          )
        )
        .returning();

      res.json({ updated: updated.length });
    } catch (error: unknown) {
      logger.error("Error bulk updating bale status:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/production-bales/import-excel", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      // Parse Excel file
      const workbook = await readExcel(req.file.buffer);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = sheetToJson(worksheet);
      const mixBatchId = req.body.mixBatchId ? parseInt(req.body.mixBatchId) : undefined;

      // Map Excel rows to bale data
      const balesData = rows.map((row) => {
        return insertProductionBaleSchema.parse({
          companyId,
          mixBatchId,
          baleCode: row.bale_code || row.baleCode || "",
          barcodeValue: row.barcode_value || row.barcodeValue || row.barcode || row.bale_code || row.baleCode || "",
          category: row.category || "",
          grade: row.grade || "",
          weightKg: row.weight_kg?.toString() || row.weightKg?.toString() || row.weight?.toString() || "0",
          costPerKg: row.cost_per_kg?.toString() || row.costPerKg?.toString() || "0",
          totalCost: row.total_cost?.toString() || row.totalCost?.toString() || "0",
          warehouseLocation: row.warehouse_location || row.warehouseLocation || "",
          status: row.status || "LABEL_PRINTED",
        });
      });

      const created = await storage.bulkCreateProductionBales(balesData);
      res.json({ success: true, count: created.length, bales: created });
    } catch (error: unknown) {
      logger.error("Error importing Excel:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
