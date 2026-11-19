// Extracted from ./registerProductionBaleRoutesPart1.ts
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../lib/money";
import { baleProducts, baleSequences, mixBatches, pressingBatches, productionBales } from "@shared/schema";

export function registerProductionBaleRoutesPart4(app: Express) {
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
}
