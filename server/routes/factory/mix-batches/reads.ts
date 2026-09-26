/**
 * factoryMixBatchRoutes: FactoryMixBatchRead endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryMixBatches } from "@shared/schema";
import { eq, and, desc, isNull } from "drizzle-orm";

export function registerFactoryMixBatchReadRoutes(app: Express) {
  app.get("/api/factory/mix-batches", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const where = and(eq(factoryMixBatches.companyId, companyId), isNull(factoryMixBatches.deletedAt));

      // Summary/picker consumers only need the batch identity and utilization
      // fields. Skip source-row loading and supplier-rate recomputation entirely.
      if (req.query.profile === "summary") {
        const rows = await db
          .select({
            id: factoryMixBatches.id,
            batchCode: factoryMixBatches.batchCode,
            name: factoryMixBatches.name,
            status: factoryMixBatches.status,
            totalWeightKg: factoryMixBatches.totalWeightKg,
            usedKg: factoryMixBatches.usedKg,
            costPerKg: factoryMixBatches.costPerKg,
            batchDate: factoryMixBatches.batchDate,
            createdAt: factoryMixBatches.createdAt,
          })
          .from(factoryMixBatches)
          .where(where)
          .orderBy(desc(factoryMixBatches.createdAt));

        return res.json(
          rows.map((batch) => ({
            ...batch,
            remainingKg: (
              (parseFloat(batch.totalWeightKg || "0") || 0) - (parseFloat(batch.usedKg || "0") || 0)
            ).toFixed(3),
          }))
        );
      }

      const results = await db.select().from(factoryMixBatches).where(where).orderBy(desc(factoryMixBatches.createdAt));

      // Mix-batch list is a historical ledger view. Use the persisted batch
      // valuation exactly as Production Overview does; never re-price old batches
      // from the supplier's current locked rate. Current supplier rates can change
      // after later offloads/corrections and some legacy suppliers have no current
      // stock rate at all, which previously made valid historical batches display
      // as $0.0000/kg here even though their stored batch valuation was correct.
      const enriched = results.map((b) => {
        const total = parseFloat(b.totalWeightKg) || 0;
        const used = parseFloat(b.usedKg) || 0;

        return {
          ...b,
          remainingKg: (total - used).toFixed(3),
          displayTotalWeightKg: (parseFloat(b.totalWeightKg || "0") || 0).toFixed(3),
          displayTotalCost: (parseFloat(b.totalCost || "0") || 0).toFixed(6),
          displayCostPerKg: (parseFloat(b.costPerKg || "0") || 0).toFixed(6),
        };
      });

      res.set("X-ERP-Payload-Profile", "mix-batches-historical-stored-costs");
      res.set("Cache-Control", "private, max-age=10");
      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching mix batches:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/mix-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [batch] = await db
        .select()
        .from(factoryMixBatches)
        .where(and(eq(factoryMixBatches.id, id), eq(factoryMixBatches.companyId, companyId)));

      if (!batch) return res.status(404).json({ message: "Mix batch not found" });

      const total = parseFloat(batch.totalWeightKg) || 0;
      const used = parseFloat(batch.usedKg) || 0;
      res.set("Cache-Control", "private, max-age=30");
      res.json({ ...batch, remainingKg: (total - used).toFixed(3) });
    } catch (error: unknown) {
      logger.error("Error fetching mix batch:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
