// Extracted from ./productionBaleRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../lib/money";
import { baleProducts, baleSequences, mixBatches, pressingBatches, productionBales } from "@shared/schema";

// Module-level bwip-js cache — loaded once on first barcode request, then reused.
// This avoids the cold-start latency of re-importing the library on every request.
type BwipJsModule = typeof import("bwip-js");

let _bwipjs: BwipJsModule | null = null;

export async function getBwipjs(): Promise<BwipJsModule> {
  if (!_bwipjs) {
    _bwipjs = await import("bwip-js");
  }
  return _bwipjs;
}

export function registerProductionBaleRoutesPart1(app: Express) {
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
      const weight = parseMoneyInput(weightPerBale);

      if (isNaN(numBales) || numBales < 1 || numBales > 1000) {
        return res.status(400).json({ message: "Quantity must be between 1 and 1000" });
      }

      if (!weight || !weight.gt(0) || weight.gt(500)) {
        return res.status(400).json({ message: "Weight must be between 1 and 500 kg" });
      }

      // Get product for bale code
      const [product] = await db.select().from(baleProducts).where(eq(baleProducts.id, productId));
      if (!product || product.companyId !== companyId) {
        return res.status(404).json({ message: "Product not found" });
      }

      let batch = null;
      let costPerKg = new MoneyDecimal(0);
      let totalCostPerBale = "0";

      if (mixBatchId) {
        batch = await storage.getMixBatchById(mixBatchId, companyId);
        if (!batch) {
          return res.status(404).json({ message: "Mix batch not found" });
        }

        const totalWeight = weight.times(numBales);
        const remainingKg = toMoney(batch.totalWeightKg).minus(toMoney(batch.usedKg));
        if (totalWeight.gt(remainingKg.plus(0.001))) {
          return res.status(400).json({
            message: `Not enough remaining in mix batch. Available: ${remainingKg.toFixed(3)} kg, Requested: ${totalWeight.toFixed(3)} kg`,
          });
        }
        costPerKg = toMoney(batch.costPerKg);
        totalCostPerBale = weight.times(costPerKg).toFixed(2);
      }

      const totalWeight = weight.times(numBales);

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
            costPerKg: costPerKg.gt(0) ? costPerKg.toString() : "0",
            totalCost: costPerKg.gt(0) ? totalCostPerBale : "0",
            status: isPressing ? "PENDING" : "IN_STOCK",
            pressedAt: new Date(),
          };

          const [bale] = await tx.insert(productionBales).values(baleData).returning();
          createdBales.push(bale);
        }

        if (batch && mixBatchId) {
          const newUsedKg = toMoney(batch.usedKg).plus(totalWeight);
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
}
